import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Gerador de resumo multi-provider ───────────────────────────────────────

async function generateSummary(prompt: string): Promise<string> {
  const provider = (Deno.env.get("AI_PROVIDER") ?? "claude").toLowerCase();

  switch (provider) {
    case "claude":  return await summaryWithClaude(prompt);
    case "gemini":  return await summaryWithGemini(prompt);
    case "groq":    return await summaryWithGroq(prompt);
    case "openai":  return await summaryWithOpenAI(prompt);
    default:        return await summaryWithClaude(prompt);
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

// ─── Prompt ──────────────────────────────────────────────────────────────────

function buildPrompt(transcript: string, durationSeconds: number): string {
  return `Você é um assistente do time de franquias da Berry Consultoria.

Analise esta transcrição de ligação telefônica entre um consultor e um lead interessado em franquia, e gere um resumo estruturado em português.

TRANSCRIÇÃO (${Math.floor(durationSeconds / 60)} min ${durationSeconds % 60} seg):
${transcript}

Gere um resumo com:
1. **Assunto principal**: O que foi discutido
2. **Interesse do lead**: Nível de interesse e tipo de franquia
3. **Próximo passo combinado**: O que foi acordado
4. **Pontos de atenção**: Objeções ou informações importantes
5. **Temperatura do lead**: Frio / Morno / Quente

Seja direto e objetivo. Máximo 150 palavras.`;
}

// ─── Função auxiliar HubSpot ─────────────────────────────────────────────────

async function createHubSpotNote(token: string, phone: string, noteBody: string): Promise<string | null> {
  try {
    const cleanPhone = phone.replace(/\D/g, "").slice(-8);

    const searchRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "phone", operator: "CONTAINS_TOKEN", value: cleanPhone }] }],
        properties: ["firstname", "phone"],
        limit: 1,
      }),
    });
    const searchData = await searchRes.json();
    const contact = searchData.results?.[0];

    const noteRes = await fetch("https://api.hubapi.com/crm/v3/objects/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        properties: { hs_note_body: noteBody, hs_timestamp: Date.now().toString() },
      }),
    });
    const noteData = await noteRes.json();

    if (contact?.id && noteData?.id) {
      await fetch(
        `https://api.hubapi.com/crm/v3/objects/notes/${noteData.id}/associations/contacts/${contact.id}/note_to_contact`,
        { method: "PUT", headers: { Authorization: `Bearer ${token}` } }
      );
      return contact.id;
    }
    return null;
  } catch (e) {
    console.error("Erro HubSpot:", e);
    return null;
  }
}

// ─── Handler principal ───────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const payload = await req.json();
    const callData = payload.data ?? payload;

    const contactPhone = callData.caller_phone ?? callData.contact_phone ?? callData.phone ?? "";
    const contactName = callData.caller_name ?? callData.contact_name ?? "Desconhecido";
    const durationSeconds = callData.duration ?? callData.duration_seconds ?? 0;
    const recordingUrl = callData.recording_url ?? callData.record_url ?? null;
    const transcript = callData.transcript ?? callData.transcription ?? null;
    const callStatus = durationSeconds > 0 ? "completed" : "missed";

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: settings } = await supabase
      .from("settings").select("hubspot_token").eq("id", 1).single();

    if (!settings?.hubspot_token) throw new Error("HubSpot token não configurado");

    // Salva log imediatamente
    const { data: logEntry } = await supabase.from("call_logs").insert({
      contact_name: contactName,
      contact_phone: contactPhone,
      duration_seconds: durationSeconds,
      status: callStatus,
      recording_url: recordingUrl,
      transcript: transcript,
      ai_summary: null,
    }).select().single();

    // Chamada perdida — nota simples e encerra
    if (callStatus === "missed" || !transcript) {
      const noteBody = `📞 *Chamada perdida — Berry Atendimento*\n\nContato: ${contactName}\nTelefone: ${contactPhone}\nHorário: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`;
      await createHubSpotNote(settings.hubspot_token, contactPhone, noteBody);
      return new Response(JSON.stringify({ success: true, type: "missed_call" }), { status: 200 });
    }

    // Gera resumo
    const summary = await generateSummary(buildPrompt(transcript, durationSeconds));

    // Atualiza log com resumo
    if (logEntry?.id) {
      await supabase.from("call_logs").update({ ai_summary: summary }).eq("id", logEntry.id);
    }

    // Cria nota no HubSpot
    const noteBody = `📞 *Ligação CloudTalk — Berry Atendimento*\n\n${summary}\n\n---\n⏱ Duração: ${Math.floor(durationSeconds / 60)}min ${durationSeconds % 60}s${recordingUrl ? `\n🎙 Gravação: ${recordingUrl}` : ""}\n_Gerado por ${Deno.env.get("AI_PROVIDER") ?? "claude"} em ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}_`;

    const hubspotContactId = await createHubSpotNote(settings.hubspot_token, contactPhone, noteBody);

    if (hubspotContactId && logEntry?.id) {
      await supabase.from("call_logs").update({ hubspot_contact_id: hubspotContactId }).eq("id", logEntry.id);
    }

    return new Response(
      JSON.stringify({ success: true, provider: Deno.env.get("AI_PROVIDER") ?? "claude", contact_found: !!hubspotContactId }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Erro no cloudtalk-webhook:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
});
