/**
 * chatwoot-events/index.ts — Supabase Edge Function
 *
 * Required secrets (Supabase Edge Function → Secrets):
 *   CHATWOOT_WEBHOOK_TOKEN_CURRENT  — active shared secret (≥32 random bytes)
 *   CHATWOOT_WEBHOOK_TOKEN_PREVIOUS — previous token (only during rotation)
 *   ALLOWED_CHATWOOT_ACCOUNT_IDS   — comma-separated e.g. "1"  [required in prod]
 *   APP_ENV                         — "production" (default)
 *   ALLOW_UNSIGNED_CHATWOOT_WEBHOOKS— "true" ONLY in non-production local dev
 *
 * Request flow (each gate aborts before the next):
 *   1. CORS preflight
 *   2. Method gate           → 405
 *   3. Token authentication  → 503 (no secret) | 401 (bad/missing token)
 *   4. Allowlist config gate → 503 (production without allowlist)
 *   5. Content-Type gate     → 415
 *   6. Body size gate        → 413 (Content-Length) | 413 (stream read)
 *   7. JSON parse            → 400
 *   8. Payload validation    → 400 | 403
 *   9. Rate limit            → 429
 *  10. Business logic
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  MAX_BODY_BYTES,
  sanitizeWebhookUrl,
  authenticateRequest,
  validateAllowlistConfig,
  validatePayload,
  readBodyWithLimit,
  checkRateLimit,
  parseAllowedAccountIds,
  resolveAccountId,
  computeDedupKey,
} from "./_helpers.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Auto-assign validation ─────────────────────────────────────────────────────

async function resolveValidatedAssignee(
  chatwootBaseUrl: string,
  chatwootToken: string,
  chatwootAccountId: number | string,
  senderId: unknown,
  conversationId: unknown,
  traceId: string,
): Promise<number | null> {
  if (typeof senderId !== "number" && typeof senderId !== "string") {
    console.warn("[auto_assign_skipped]", JSON.stringify({ traceId, reason: "sender.id missing or wrong type" }));
    return null;
  }
  const agentId = Number(senderId);
  if (!Number.isInteger(agentId) || agentId <= 0) {
    console.warn("[auto_assign_skipped]", JSON.stringify({ traceId, reason: "sender.id not a positive integer" }));
    return null;
  }

  try {
    const agentRes = await fetch(
      `${chatwootBaseUrl}/api/v1/accounts/${chatwootAccountId}/agents/${agentId}`,
      { headers: { api_access_token: chatwootToken } },
    );
    if (!agentRes.ok) {
      console.warn("[auto_assign_skipped]", JSON.stringify({ traceId, reason: "agent not found", status: agentRes.status }));
      return null;
    }

    const convRes = await fetch(
      `${chatwootBaseUrl}/api/v1/accounts/${chatwootAccountId}/conversations/${conversationId}`,
      { headers: { api_access_token: chatwootToken } },
    );
    if (!convRes.ok) {
      console.warn("[auto_assign_skipped]", JSON.stringify({ traceId, reason: "conversation not found", status: convRes.status }));
      return null;
    }
    const conv = await convRes.json();
    const inboxId = conv.inbox_id;
    if (!inboxId) {
      console.warn("[auto_assign_skipped]", JSON.stringify({ traceId, reason: "no inbox_id" }));
      return null;
    }

    const inboxRes = await fetch(
      `${chatwootBaseUrl}/api/v1/accounts/${chatwootAccountId}/inbox_members/${inboxId}`,
      { headers: { api_access_token: chatwootToken } },
    );
    if (!inboxRes.ok) {
      console.warn("[auto_assign_skipped]", JSON.stringify({ traceId, reason: "inbox_members check failed", status: inboxRes.status }));
      return null;
    }
    const inboxData = await inboxRes.json();
    const members: Array<{ id: number }> = inboxData.payload ?? [];
    if (!members.some((m) => m.id === agentId)) {
      console.warn("[auto_assign_skipped]", JSON.stringify({ traceId, reason: "agent not member of inbox", agentId, inboxId }));
      return null;
    }

    return agentId;
  } catch (err) {
    console.warn("[auto_assign_skipped]", JSON.stringify({ traceId, reason: "validation threw", error: (err as Error).message }));
    return null;
  }
}

// ── Main handler ───────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // ── 1. Method gate ────────────────────────────────────────────────────────
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ── 2. Token authentication — BEFORE any other processing ─────────────────
  const appEnv = Deno.env.get("APP_ENV") ?? "production";
  const isProduction = appEnv === "production";
  const tokenCurrent = Deno.env.get("CHATWOOT_WEBHOOK_TOKEN_CURRENT");
  const tokenPrevious = Deno.env.get("CHATWOOT_WEBHOOK_TOKEN_PREVIOUS");
  const allowUnsigned = !isProduction && Deno.env.get("ALLOW_UNSIGNED_CHATWOOT_WEBHOOKS") === "true";

  let authSlot: "current" | "previous" | "unsigned" = "unsigned";

  if (!tokenCurrent) {
    // ALLOW_UNSIGNED is impossible in production regardless of env var value
    if (isProduction || !allowUnsigned) {
      console.error("chatwoot-events: CHATWOOT_WEBHOOK_TOKEN_CURRENT not configured");
      return new Response(
        JSON.stringify({ error: "Service unavailable" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    // Reaches here only in non-production with explicit ALLOW_UNSIGNED=true
    console.warn("chatwoot-events: accepting unsigned webhook — local dev bypass");
  } else {
    const url = new URL(req.url);
    // .get() returns the first value when a key appears multiple times — safe
    const providedToken = url.searchParams.get("token");
    const authResult = await authenticateRequest(providedToken, tokenCurrent, tokenPrevious);

    if (!authResult.ok) {
      // Log only sanitized path — never the token, its length, or any prefix
      console.warn("chatwoot-events: auth failed", authResult.reason, sanitizeWebhookUrl(req.url));
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    authSlot = authResult.slot; // "current" or "previous" — logged below for audit
  }

  // ── 3. Allowlist config gate — fail-closed in production ──────────────────
  const allowedAccountIds = parseAllowedAccountIds(Deno.env.get("ALLOWED_CHATWOOT_ACCOUNT_IDS"));
  const allowlistCheck = validateAllowlistConfig(allowedAccountIds, isProduction);
  if (!allowlistCheck.ok) {
    console.error("chatwoot-events: ALLOWED_CHATWOOT_ACCOUNT_IDS not configured in production");
    return new Response(
      JSON.stringify({ error: allowlistCheck.error }),
      { status: allowlistCheck.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ── 4. Content-Type gate ──────────────────────────────────────────────────
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return new Response(
      JSON.stringify({ error: "Unsupported media type" }),
      { status: 415, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ── 5. Body size gate — Content-Length fast path ──────────────────────────
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return new Response(
      JSON.stringify({ error: "Payload too large" }),
      { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ── 6. Body read with hard stream limit ───────────────────────────────────
  const bodyResult = await readBodyWithLimit(req.body, MAX_BODY_BYTES);
  if (!bodyResult.ok) {
    // Never log body content
    console.warn("chatwoot-events: payload stream exceeded limit");
    return new Response(
      JSON.stringify({ error: "Payload too large" }),
      { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const rawBody = bodyResult.text;

  // ── 7. JSON parse ─────────────────────────────────────────────────────────
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ── 8. Payload validation (account, event, field types) ───────────────────
  const validation = validatePayload(payload, allowedAccountIds);
  if (!validation.ok) {
    console.warn("chatwoot-events: payload rejected", JSON.stringify({ error: validation.error }));
    return new Response(
      JSON.stringify({ error: validation.error }),
      { status: validation.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ── 9. Rate limit (after auth + account validation) ───────────────────────
  // Key: tokenSlot:accountId:ip — keying by slot prevents evasion via rotating
  // accountId values while using the same authenticated session.
  // This limiter is per-instance (not global) — see _helpers.ts for details.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  // resolveAccountId is guaranteed non-null here (validatePayload already checked)
  const accountId = resolveAccountId(payload) as number;
  const rateLimitKey = `${authSlot}:${accountId}:${ip}`;
  if (!checkRateLimit(rateLimitKey)) {
    console.warn("chatwoot-events: rate limit exceeded", JSON.stringify({ accountId, slot: authSlot }));
    return new Response(
      JSON.stringify({ error: "Too many requests" }),
      {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": "60" },
      },
    );
  }

  // ── 10. Business logic ────────────────────────────────────────────────────
  const traceId = crypto.randomUUID();
  // Log which token slot authenticated — never the value, length, or prefix
  console.info("chatwoot-events: processing", JSON.stringify({ traceId, slot: authSlot, accountId }));

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const conversation = payload.conversation as Record<string, unknown> | undefined;
    const sender = payload.sender as Record<string, unknown> | undefined;
    const dedupKey = await computeDedupKey(payload);

    const { error: insertError } = await supabase.from("chatwoot_events").insert({
      event_type: payload.event ?? "unknown",
      account_id: accountId,
      conversation_id: conversation?.id ?? null,
      message_type: payload.message_type ?? null,
      content: payload.content ?? null,
      sender_name: sender?.name ?? null,
      message_id: typeof payload.id === "number" ? payload.id : null,
      dedup_key: dedupKey,
    });

    if (insertError) {
      if (insertError.code === "23505") {
        console.info("chatwoot-events: duplicate ignored", JSON.stringify({ traceId, dedupKey }));
        return new Response(
          JSON.stringify({ ok: true, traceId, deduplicated: true }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      console.error("chatwoot-events: insert error", JSON.stringify({ code: insertError.code }));
    }

    // Auto-assign (sender.id validated via Chatwoot REST before use)
    const isMessageCreated = payload.event === "message_created";
    const isOutgoing = payload.message_type === "outgoing";
    const assignee = (conversation?.meta as Record<string, unknown>)?.assignee;
    const isUnassigned = !assignee;
    const senderIsUser = sender?.type === "user";

    if (isMessageCreated && isOutgoing && isUnassigned && senderIsUser && sender?.id) {
      const { data: settings } = await supabase
        .from("settings")
        .select("chatwoot_url, chatwoot_account_id, chatwoot_token")
        .eq("id", 1)
        .single();

      if (settings?.chatwoot_token && settings?.chatwoot_url) {
        const baseUrl = (settings.chatwoot_url as string).trim().replace(/\/$/, "");
        const convId = conversation?.id;

        const validatedAssigneeId = await resolveValidatedAssignee(
          baseUrl,
          settings.chatwoot_token as string,
          settings.chatwoot_account_id as string,
          sender.id,
          convId,
          traceId,
        );

        if (validatedAssigneeId && convId) {
          const assignRes = await fetch(
            `${baseUrl}/api/v1/accounts/${settings.chatwoot_account_id}/conversations/${convId}/assignments`,
            {
              method: "POST",
              headers: {
                api_access_token: settings.chatwoot_token as string,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ assignee_id: validatedAssigneeId }),
            },
          );
          if (!assignRes.ok) {
            console.warn("[auto_assign_failed]", JSON.stringify({ traceId, convId, agentId: validatedAssigneeId, status: assignRes.status }));
          }
        }
      }
    }

    return new Response(
      JSON.stringify({ ok: true, traceId }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("chatwoot-events: unhandled error", JSON.stringify({ traceId, error: (error as Error).message }));
    return new Response(
      JSON.stringify({ error: "Internal error", traceId }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
