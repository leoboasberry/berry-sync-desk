import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Gerador de resumo multi-provider ───────────────────────────────────────

async function generateSummary(prompt: string): Promise<string> {
  const provider = (Deno.env.get("AI_PROVIDER") ?? "claude").toLowerCase();

  switch (provider) {
    case "claude":
      return await summaryWithClaude(prompt);
    case "gemini":
      return await summaryWithGemini(prompt);
    case "groq":
      return await summaryWithGroq(prompt);
    case "openai":
      return await summaryWithOpenAI(prompt);
    default:
      return await summaryWithClaude(prompt);
  }
}

async function summaryWithClaude(prompt: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: Deno.env.get("AI_MODEL") ?? "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude error: ${JSON.stringify(data)}`);
  return data.content?.[0]?.text ?? "Resumo não disponível";
}

async function summaryWithGemini(prompt: string): Promise<string> {
  const model = Deno.env.get("AI_MODEL") ?? "gemini-2.0-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${Deno.env.get("GEMINI_API_KEY")}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 1000 },
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini error: ${JSON.stringify(data)}`);
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "Resumo não disponível";
}

async function summaryWithGroq(prompt: string): Promise<string> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("GROQ_API_KEY")}`,
    },
    body: JSON.stringify({
      model: Deno.env.get("AI_MODEL") ?? "llama-3.3-70b-versatile",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Groq error: ${JSON.stringify(data)}`);
  return data.choices?.[0]?.message?.content ?? "Resumo não disponível";
}

async function summaryWithOpenAI(prompt: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
    },
    body: JSON.stringify({
      model: Deno.env.get("AI_MODEL") ?? "gpt-4o-mini",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI error: ${JSON.stringify(data)}`);
  return data.choices?.[0]?.message?.content ?? "Resumo não disponível";
}

// ─── Prompt padrão ───────────────────────────────────────────────────────────

function buildPrompt(transcript: string): string {
  return `Você é um assistente do time de franquias da Berry Consultoria.

Analise esta conversa de WhatsApp entre um consultor e um lead interessado em franquia, e gere um resumo estruturado em português.

CONVERSA:
${transcript}

Gere um resumo com:
1. **Interesse do lead**: O que demonstrou interesse / qual franquia / qual região
2. **Próximo passo combinado**: O que foi acordado ao final
3. **Pontos de atenção**: Objeções, dúvidas ou informações importantes
4. **Temperatura do lead**: Frio / Morno / Quente

Seja direto e objetivo. Máximo 150 palavras.`;
}

// ─── Handler principal ───────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const payload = await req.json();

    if (payload.event !== "conversation_status_changed" || payload.status !== "resolved") {
      return new Response(JSON.stringify({ skipped: true }), { status: 200 });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: settings } = await supabase
      .from("settings")
      .select("chatwoot_url, chatwoot_token, hubspot_token")
      .eq("id", 1)
      .single();

    if (!settings?.chatwoot_token || !settings?.hubspot_token) {
      throw new Error("Credenciais não configuradas em Settings");
    }

    const conversationId = payload.id;
    const accountId = payload.account_id;
    const contactPhone = payload.meta?.sender?.phone_number ?? "";
    const contactName = payload.meta?.sender?.name ?? "Desconhecido";

    // Busca mensagens da conversa
    const msgsRes = await fetch(
      `${settings.chatwoot_url}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
      { headers: { api_access_token: settings.chatwoot_token } }
    );
    const msgsData = await msgsRes.json();
    const messages = msgsData.payload ?? [];

    const transcript = messages
      .filter((m: any) => m.content && m.message_type !== 3)
      .map((m: any) => {
        const role = m.message_type === 1 ? "Consultor" : "Lead";
        const time = new Date(m.created_at * 1000).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
        return `[${time}] ${role}: ${m.content}`;
      })
      .join("\n");

    if (!transcript) {
      return new Response(JSON.stringify({ skipped: "sem mensagens" }), { status: 200 });
    }

    // Gera resumo com o provider configurado
    const summary = await generateSummary(buildPrompt(transcript));

    // Busca contato no HubSpot
    const phone = contactPhone.replace(/\D/g, "").slice(-8);
    const searchRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.hubspot_token}`,
      },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "phone", operator: "CONTAINS_TOKEN", value: phone }] }],
        properties: ["firstname", "lastname", "phone", "hs_lead_status"],
        limit: 1,
      }),
    });
    const searchData = await searchRes.json();
    const contact = searchData.results?.[0];

    // Cria nota no HubSpot
    const noteBody = `📱 *Atendimento WhatsApp — Berry Atendimento*\n\n${summary}\n\n---\n_Gerado por ${Deno.env.get("AI_PROVIDER") ?? "claude"} em ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}_`;

    const noteRes = await fetch("https://api.hubapi.com/crm/v3/objects/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.hubspot_token}` },
      body: JSON.stringify({
        properties: { hs_note_body: noteBody, hs_timestamp: Date.now().toString() },
      }),
    });
    const noteData = await noteRes.json();

    if (contact?.id && noteData?.id) {
      await fetch(
        `https://api.hubapi.com/crm/v3/objects/notes/${noteData.id}/associations/contacts/${contact.id}/note_to_contact`,
        { method: "PUT", headers: { Authorization: `Bearer ${settings.hubspot_token}` } }
      );

      const currentStatus = contact.properties?.hs_lead_status;
      if (!currentStatus || currentStatus === "NEW" || currentStatus === "OPEN") {
        await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contact.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.hubspot_token}` },
          body: JSON.stringify({ properties: { hs_lead_status: "CONNECTED" } }),
        });
      }
    }

    await supabase.from("call_logs").insert({
      contact_name: contactName,
      contact_phone: contactPhone,
      hubspot_contact_id: contact?.id ?? null,
      status: "whatsapp",
      ai_summary: summary,
      transcript: transcript,
      duration_seconds: 0,
    });

    return new Response(
      JSON.stringify({ success: true, provider: Deno.env.get("AI_PROVIDER") ?? "claude", contact_found: !!contact?.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Erro no clever-responder:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
});
