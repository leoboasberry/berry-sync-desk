import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function verifyHmac(rawBody: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // Constant-time comparison via length + XOR to avoid timing attacks
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const secret = Deno.env.get("CHATWOOT_WEBHOOK_SECRET");

  // If secret is configured, enforce HMAC verification
  if (secret) {
    const rawBody = await req.text();
    const signature = req.headers.get("x-chatwoot-hmac-sha256");
    const valid = await verifyHmac(rawBody, signature, secret);
    if (!valid) {
      console.warn("chatwoot-events: invalid or missing HMAC signature");
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // Re-parse after text read
    try {
      const payload = JSON.parse(rawBody);
      return await handlePayload(payload);
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // No secret configured: log warning and allow (allows gradual rollout)
  console.warn("chatwoot-events: CHATWOOT_WEBHOOK_SECRET not set — running unauthenticated");
  try {
    const payload = await req.json();
    return await handlePayload(payload);
  } catch (error) {
    console.error("chatwoot-events error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});

async function computePayloadHash(parts: string[]): Promise<string> {
  const data = new TextEncoder().encode(parts.join("|"));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function handlePayload(payload: Record<string, unknown>): Promise<Response> {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const conversation = payload.conversation as Record<string, unknown> | undefined;
    const sender = payload.sender as Record<string, unknown> | undefined;

    // B05: compute dedup hash from stable payload fields (no timestamps)
    const payloadHash = await computePayloadHash([
      String(payload.event ?? ""),
      String(payload.account_id ?? ""),
      String(conversation?.id ?? ""),
      String(payload.content ?? ""),
      String(sender?.name ?? ""),
    ]);

    // ON CONFLICT DO NOTHING: replay of same payload is silently discarded
    await supabase.from("chatwoot_events").insert({
      event_type: payload.event ?? "unknown",
      account_id: payload.account_id ?? null,
      conversation_id: conversation?.id ?? null,
      message_type: payload.message_type ?? null,
      content: payload.content ?? null,
      sender_name: sender?.name ?? null,
      payload_hash: payloadHash,
    }).onConflict("payload_hash").ignore();

    // Auto-assign: when an outgoing message is created in an unassigned conversation
    if (
      payload.event === "message_created" &&
      payload.message_type === "outgoing" &&
      !(conversation?.meta as Record<string, unknown>)?.assignee &&
      sender?.type === "user" &&
      sender?.id
    ) {
      const { data: settings } = await supabase
        .from("settings")
        .select("chatwoot_url, chatwoot_account_id, chatwoot_token")
        .eq("id", 1)
        .single();

      if (settings?.chatwoot_token) {
        const baseUrl = (settings.chatwoot_url as string).trim().replace(/\/$/, "");
        const convId = conversation?.id;
        const agentId = sender.id;

        if (convId && agentId) {
          await fetch(
            `${baseUrl}/api/v1/accounts/${settings.chatwoot_account_id}/conversations/${convId}/assignments`,
            {
              method: "POST",
              headers: {
                api_access_token: settings.chatwoot_token,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ assignee_id: agentId }),
            }
          );
        }
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("chatwoot-events error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { corsHeaders } as HeadersInit,
    });
  }
}
