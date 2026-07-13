import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const payload = await req.json();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    await supabase.from("chatwoot_events").insert({
      event_type: payload.event ?? "unknown",
      account_id: payload.account_id ?? null,
      conversation_id: payload.conversation?.id ?? null,
      message_type: payload.message_type ?? null,
      content: payload.content ?? null,
      sender_name: payload.sender?.name ?? null,
    });

    // Auto-assign: when an outgoing message is created in an unassigned conversation
    if (
      payload.event === "message_created" &&
      payload.message_type === "outgoing" &&
      !payload.conversation?.meta?.assignee?.id &&
      payload.sender?.type === "user" &&
      payload.sender?.id
    ) {
      const { data: settings } = await supabase
        .from("settings")
        .select("chatwoot_url, chatwoot_account_id, chatwoot_token")
        .eq("id", 1)
        .single();

      if (settings?.chatwoot_token) {
        const baseUrl = settings.chatwoot_url.trim().replace(/\/$/, "");
        const convId = payload.conversation?.id;
        const agentId = payload.sender.id;

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
      headers: corsHeaders,
    });
  }
});
