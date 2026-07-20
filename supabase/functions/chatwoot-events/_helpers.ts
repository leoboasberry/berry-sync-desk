/**
 * chatwoot-events/_helpers.ts
 *
 * Pure functions with no Deno or Supabase dependencies.
 * Importable from both the Edge Function (Deno) and Vitest tests (Node ≥18).
 *
 * ─── SECURITY LIMITATION (documented) ────────────────────────────────────────
 * This Chatwoot installation does not support HMAC payload signing.
 * Authentication uses a shared secret in the query string (?token=…) because
 * no header signing mechanism is available.
 *
 * Properties of this control:
 *   - Provides authentication (caller knows the full URL), NOT integrity.
 *   - Anyone who obtains the token can send arbitrary payloads.
 *   - Replay is mitigated by dedup_key, not eliminated cryptographically.
 *   - The token appears in the query string — it may be recorded by:
 *       • gateway / proxy access logs that capture query strings;
 *       • Chatwoot outbound request logs;
 *       • network analysis tools.
 *     Mitigations: unique token per webhook, immediate rotation on suspicion,
 *     never paste the full URL in tickets/chats/logs, verify proxy log config.
 *   - Upgrading Chatwoot to a version with HMAC header signing is the
 *     recommended long-term solution.
 *
 * Required secrets (Supabase Edge Function → Secrets):
 *   CHATWOOT_WEBHOOK_TOKEN_CURRENT  — active shared secret (≥32 random bytes)
 *   CHATWOOT_WEBHOOK_TOKEN_PREVIOUS — previous token (only during key rotation)
 *   ALLOWED_CHATWOOT_ACCOUNT_IDS   — comma-separated account IDs, e.g. "1"
 *   APP_ENV                         — "production" (default if absent)
 *   ALLOW_UNSIGNED_CHATWOOT_WEBHOOKS — "true" ONLY in non-production local dev
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_BODY_BYTES = 512 * 1024; // 512 KB

export const ALLOWED_EVENTS = new Set([
  "conversation_created",
  "conversation_status_changed",
  "conversation_updated",
  "message_created",
  "message_updated",
  "webwidget_triggered",
  "contact_created",
  "contact_updated",
  "conversation_typing_on",
  "conversation_typing_off",
]);

// ── URL sanitization ──────────────────────────────────────────────────────────
// NEVER log the full request URL — it contains the secret token.
// Note: sanitization controls OUR logs only; proxy/gateway/Chatwoot logs are
// outside our control. Verify query-string capture in those systems separately.

export function sanitizeWebhookUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.searchParams.delete("token");
    return `${url.pathname}?token=[REDACTED]`;
  } catch {
    return "[invalid-url]";
  }
}

// ── SHA-256 token hashing ─────────────────────────────────────────────────────
// Hash both sides before comparison to achieve fixed 32-byte comparison
// regardless of input length. Prevents timing oracle on token length/prefix.

export async function hashToken(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

export function safeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  // Always iterate all 32 bytes — no early return based on content or length
  if (a.length !== 32 || b.length !== 32) return false;
  let diff = 0;
  for (let i = 0; i < 32; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

// ── Token authentication ──────────────────────────────────────────────────────
// Secrets: CHATWOOT_WEBHOOK_TOKEN_CURRENT (required) and
//          CHATWOOT_WEBHOOK_TOKEN_PREVIOUS (optional, only during rotation).
// An empty PREVIOUS is never accepted as a valid token.

export type AuthResult =
  | { ok: true; slot: "current" | "previous" }
  | { ok: false; reason: "no_secret" | "missing_token" | "invalid_token" };

export async function authenticateRequest(
  providedToken: string | null,
  tokenCurrent: string | null | undefined,
  tokenPrevious: string | null | undefined = null,
): Promise<AuthResult> {
  if (!tokenCurrent) return { ok: false, reason: "no_secret" };
  if (!providedToken) return { ok: false, reason: "missing_token" };

  const [hProvided, hCurrent] = await Promise.all([
    hashToken(providedToken),
    hashToken(tokenCurrent),
  ]);

  if (safeEqualBytes(hProvided, hCurrent)) return { ok: true, slot: "current" };

  // Accept previous token only during rotation and only when it is non-empty
  if (tokenPrevious) {
    const hPrevious = await hashToken(tokenPrevious);
    if (safeEqualBytes(hProvided, hPrevious)) return { ok: true, slot: "previous" };
  }

  return { ok: false, reason: "invalid_token" };
}

// ── Allowlist configuration validation ───────────────────────────────────────
// In production, the allowlist MUST be configured and non-empty.
// An absent or empty allowlist in production is a configuration error → 503.
// In non-production, absence is allowed (permissive by default for dev).

export function validateAllowlistConfig(
  allowedAccountIds: Set<number> | null,
  isProduction: boolean,
): { ok: true } | { ok: false; status: 503; error: string } {
  if (isProduction && (allowedAccountIds === null || allowedAccountIds.size === 0)) {
    return {
      ok: false,
      status: 503,
      error: "Service unavailable",
    };
  }
  return { ok: true };
}

// ── Payload validation ────────────────────────────────────────────────────────

export type ValidationResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

export function validatePayload(
  payload: Record<string, unknown>,
  allowedAccountIds: Set<number> | null,
): ValidationResult {
  // Resolve account_id from either top-level field OR nested account.id.
  // Chatwoot versions differ: some send account_id directly, others send
  // account: { id: N } as a nested object. Accept both forms.
  const accountId = resolveAccountId(payload);
  if (accountId === null) {
    return { ok: false, status: 400, error: "Missing or invalid account_id" };
  }

  // account allowlist (null = no restriction, valid for dev)
  if (allowedAccountIds !== null && !allowedAccountIds.has(accountId)) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  // event allowlist
  const event = payload.event;
  if (typeof event !== "string" || !ALLOWED_EVENTS.has(event)) {
    return { ok: false, status: 400, error: "Unknown or missing event type" };
  }

  // conversation_id: positive integer when present
  const conversation = payload.conversation as Record<string, unknown> | undefined;
  if (conversation != null) {
    const convId = conversation.id;
    if (convId != null) {
      if (typeof convId !== "number" || !Number.isInteger(convId) || convId <= 0) {
        return { ok: false, status: 400, error: "Invalid conversation_id" };
      }
    }
  }

  // message_id (payload.id): positive integer when present
  const messageId = payload.id;
  if (messageId != null) {
    if (typeof messageId !== "number" || !Number.isInteger(messageId) || messageId <= 0) {
      return { ok: false, status: 400, error: "Invalid message_id" };
    }
  }

  return { ok: true };
}

// ── Body reading with hard stream limit ───────────────────────────────────────
// Do NOT rely solely on Content-Length (can be absent or falsified).
// Reads the stream chunk-by-chunk and aborts as soon as bytes exceed maxBytes.
// Body is never logged.

export async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; tooLarge: true }> {
  if (!body) return { ok: true, text: "" };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

// ── Rate limiting (in-memory, per Edge Function instance) ─────────────────────
// NOTE: Supabase Edge Functions may scale to multiple instances.
// This limiter operates per-instance and is a first-layer defense, NOT a
// global or distributed rate limit. Do not present it as protection against
// distributed abuse. Use it to catch runaway clients on a single instance.
//
// Key: tokenSlot + allowedAccountId + clientIp
// Keying by tokenSlot prevents evasion by rotating accountId values while
// staying within the same authenticated session.

export type RateLimitStore = Map<string, { count: number; windowStart: number }>;

export const RATE_WINDOW_MS = 60_000;
export const RATE_MAX = 300;

const _defaultStore: RateLimitStore = new Map();

export function checkRateLimit(
  key: string,
  now = Date.now(),
  store: RateLimitStore = _defaultStore,
): boolean {
  const entry = store.get(key);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    store.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_MAX) return false;
  entry.count++;
  return true;
}

export function resetRateLimitStore(store: RateLimitStore = _defaultStore): void {
  store.clear();
}

// ── Allowlist parser ──────────────────────────────────────────────────────────

export function parseAllowedAccountIds(raw: string | undefined): Set<number> | null {
  if (!raw?.trim()) return null;
  const ids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n > 0);
  return ids.length > 0 ? new Set(ids) : null;
}

// ── Account ID resolver ───────────────────────────────────────────────────────
// Shared helper used by validatePayload, computeDedupKey, and index.ts insert.

export function resolveAccountId(payload: Record<string, unknown>): number | null {
  const nested = payload.account as Record<string, unknown> | undefined;
  const raw =
    typeof payload.account_id === "number"
      ? payload.account_id
      : typeof nested?.id === "number"
      ? nested.id
      : null;
  return raw !== null && Number.isInteger(raw) && raw > 0 ? raw : null;
}

// ── Deduplication v2 ──────────────────────────────────────────────────────────

export function canonicalJson(obj: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

export async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function computeDedupKey(payload: Record<string, unknown>): Promise<string> {
  const conversation = payload.conversation as Record<string, unknown> | undefined;
  const sender = payload.sender as Record<string, unknown> | undefined;
  const messageId = payload.id as number | string | undefined;
  // Use the resolved account_id (handles both account_id and account.id forms)
  const accountId = resolveAccountId(payload);

  let identity: Record<string, unknown>;

  if (messageId != null) {
    identity = {
      version: 2,
      accountId,
      eventType: payload.event ?? null,
      messageId,
    };
  } else {
    identity = {
      version: 2,
      accountId,
      eventType: payload.event ?? null,
      conversationId: conversation?.id ?? null,
      senderId: sender?.id ?? null,
      createdAt: payload.created_at ?? null,
      sourceId: payload.source_id ?? null,
    };
  }

  return sha256hex(canonicalJson(identity));
}
