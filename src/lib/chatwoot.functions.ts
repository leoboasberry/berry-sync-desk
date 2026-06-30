import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const testChatwootConnection = createServerFn({ method: "POST" })
  .inputValidator((data: { url: string; token: string }) => data)
  .handler(async ({ data }) => {
    const url = data.url.trim().replace(/\/$/, "");
    const token = data.token.trim();
    if (!url || !token) {
      return { ok: false, status: 0, message: "URL ou token vazio" };
    }
    try {
      const res = await fetch(`${url}/api/v1/profile`, {
        headers: { api_access_token: token },
      });
      const body = await res.text();
      return { ok: res.ok, status: res.status, message: res.ok ? "OK" : body.slice(0, 200) };
    } catch (err) {
      return { ok: false, status: 0, message: (err as Error).message };
    }
  });

async function getChatwootSettings() {
  const { data } = await supabaseAdmin
    .from("settings")
    .select("chatwoot_url, chatwoot_account_id, chatwoot_token")
    .eq("id", 1)
    .single();
  if (!data?.chatwoot_token) throw new Error("Chatwoot não configurado");
  return { ...data, url: data.chatwoot_url!.trim().replace(/\/$/, "") };
}

export const getChatwootConversations = createServerFn({ method: "POST" })
  .inputValidator((data: { status: "open" | "pending" | "resolved" }) => data)
  .handler(async ({ data }) => {
    const s = await getChatwootSettings();
    const res = await fetch(
      `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations?status=${data.status}&page=1`,
      { headers: { api_access_token: s.chatwoot_token! } }
    );
    if (!res.ok) throw new Error(`Chatwoot error: ${res.status}`);
    const json = await res.json();
    return (json.data?.payload ?? []) as any[];
  });

export const getAllChatwootConversations = createServerFn({ method: "POST" })
  .inputValidator((data: { status: "open" | "pending" | "resolved" }) => data)
  .handler(async ({ data }) => {
    const s = await getChatwootSettings();
    const all: any[] = [];
    let page = 1;
    while (true) {
      const res = await fetch(
        `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations?status=${data.status}&page=${page}`,
        { headers: { api_access_token: s.chatwoot_token! } }
      );
      if (!res.ok) throw new Error(`Chatwoot error: ${res.status}`);
      const json = await res.json();
      const batch: any[] = json.data?.payload ?? [];
      all.push(...batch);
      if (batch.length < 25) break;
      page++;
    }
    return all;
  });

export const getChatwootMessages = createServerFn({ method: "POST" })
  .inputValidator((data: { conversationId: number }) => data)
  .handler(async ({ data }) => {
    const s = await getChatwootSettings();
    const res = await fetch(
      `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations/${data.conversationId}/messages`,
      { headers: { api_access_token: s.chatwoot_token! } }
    );
    if (!res.ok) throw new Error(`Chatwoot error: ${res.status}`);
    const json = await res.json();
    return (json.payload ?? []) as any[];
  });

export const sendChatwootMessage = createServerFn({ method: "POST" })
  .inputValidator((data: { conversationId: number; content: string }) => data)
  .handler(async ({ data }) => {
    const s = await getChatwootSettings();
    const res = await fetch(
      `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations/${data.conversationId}/messages`,
      {
        method: "POST",
        headers: {
          api_access_token: s.chatwoot_token!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: data.content, message_type: "outgoing" }),
      }
    );
    if (!res.ok) throw new Error(`Chatwoot error: ${res.status}`);
    return await res.json();
  });

async function getWhatsAppInboxId(s: { url: string; chatwoot_account_id: string | null; chatwoot_token: string | null }): Promise<number> {
  const res = await fetch(
    `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/inboxes`,
    { headers: { api_access_token: s.chatwoot_token! } }
  );
  if (!res.ok) throw new Error(`Chatwoot inboxes error: ${res.status}`);
  const json = await res.json();
  const inbox = (json.payload ?? []).find((i: any) => i.channel_type === "Channel::Whatsapp");
  if (!inbox) throw new Error("Inbox WhatsApp não encontrado");
  return inbox.id as number;
}

export const getChatwootTemplates = createServerFn({ method: "POST" })
  .handler(async () => {
    const s = await getChatwootSettings();

    // Get inbox with provider_config to obtain WABA credentials
    const inboxesRes = await fetch(
      `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/inboxes`,
      { headers: { api_access_token: s.chatwoot_token! } }
    );
    if (!inboxesRes.ok) throw new Error(`Chatwoot inboxes error: ${inboxesRes.status}`);
    const inboxesJson = await inboxesRes.json();
    const inbox = (inboxesJson.payload ?? []).find((i: any) => i.channel_type === "Channel::Whatsapp");
    if (!inbox) throw new Error("Inbox WhatsApp não encontrado");

    const wabaId = inbox.provider_config?.business_account_id;
    const metaToken = inbox.provider_config?.api_key;
    if (!wabaId || !metaToken) throw new Error("WABA ID ou token Meta não configurado no inbox");

    // Fetch templates from Meta Graph API
    const res = await fetch(
      `https://graph.facebook.com/v20.0/${wabaId}/message_templates?access_token=${metaToken}&limit=100&fields=name,status,category,language,components`
    );
    if (!res.ok) throw new Error(`Meta API error: ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`Meta API: ${json.error.message}`);

    return { templates: (json.data ?? []) as any[], inboxId: inbox.id as number };
  });

export const createWhatsAppTemplate = createServerFn({ method: "POST" })
  .inputValidator((data: {
    name: string;
    category: string;
    language: string;
    header?: string;
    body: string;
    footer?: string;
    bodyExamples: string[];
  }) => data)
  .handler(async ({ data }) => {
    const s = await getChatwootSettings();
    const inboxesRes = await fetch(
      `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/inboxes`,
      { headers: { api_access_token: s.chatwoot_token! } }
    );
    if (!inboxesRes.ok) throw new Error(`Chatwoot inboxes error: ${inboxesRes.status}`);
    const inboxesJson = await inboxesRes.json();
    const inbox = (inboxesJson.payload ?? []).find((i: any) => i.channel_type === "Channel::Whatsapp");
    if (!inbox) throw new Error("Inbox WhatsApp não encontrado");

    const wabaId = inbox.provider_config?.business_account_id;
    const metaToken = inbox.provider_config?.api_key;
    if (!wabaId || !metaToken) throw new Error("WABA ID ou token Meta não configurado");

    const components: any[] = [];

    if (data.header?.trim()) {
      components.push({ type: "HEADER", format: "TEXT", text: data.header.trim() });
    }

    const bodyComponent: any = { type: "BODY", text: data.body };
    if (data.bodyExamples.length > 0) {
      bodyComponent.example = { body_text: [data.bodyExamples] };
    }
    components.push(bodyComponent);

    if (data.footer?.trim()) {
      components.push({ type: "FOOTER", text: data.footer.trim() });
    }

    const res = await fetch(
      `https://graph.facebook.com/v20.0/${wabaId}/message_templates`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${metaToken}` },
        body: JSON.stringify({
          name: data.name,
          category: data.category,
          language: data.language,
          components,
        }),
      }
    );
    const json = await res.json();
    if (json.error) throw new Error(json.error.error_user_msg ?? json.error.message);
    return json as { id: string; status: string };
  });

export const getChatwootAgents = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, never>) => data)
  .handler(async () => {
    const s = await getChatwootSettings();
    const res = await fetch(
      `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/agents`,
      { headers: { api_access_token: s.chatwoot_token! } }
    );
    if (!res.ok) throw new Error(`Chatwoot error: ${res.status}`);
    return (await res.json()) as { id: number; name: string; email: string; availability_status: string }[];
  });

export const assignChatwootConversation = createServerFn({ method: "POST" })
  .inputValidator((data: { conversationId: number; assigneeId: number | null }) => data)
  .handler(async ({ data }) => {
    const s = await getChatwootSettings();
    const res = await fetch(
      `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations/${data.conversationId}/assignments`,
      {
        method: "POST",
        headers: { api_access_token: s.chatwoot_token!, "Content-Type": "application/json" },
        body: JSON.stringify({ assignee_id: data.assigneeId }),
      }
    );
    if (!res.ok) throw new Error(`Chatwoot error: ${res.status}`);
    return await res.json();
  });

export const startConversationWithTemplate = createServerFn({ method: "POST" })
  .inputValidator((data: {
    phone: string;
    contactName: string;
    templateName: string;
    templateParams: string[];
    language: string;
    category: string;
    templateBody: string;
    assigneeEmail?: string;
  }) => data)
  .handler(async ({ data }) => {
    const s = await getChatwootSettings();
    const inboxId = await getWhatsAppInboxId(s);

    // Normalize phone: strip spaces/dashes/parens, ensure leading +
    const normalizedPhone = (() => {
      const digitsAndPlus = data.phone.replace(/[^\d+]/g, "");
      const pure = digitsAndPlus.replace(/\+/g, "");
      return `+${pure}`;
    })();

    // Search contact by phone — handle Chatwoot v2 (payload: [...]) and v3 (payload: { contacts: [...] })
    const searchRes = await fetch(
      `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/contacts/search?q=${encodeURIComponent(normalizedPhone)}&include_contacts=true`,
      { headers: { api_access_token: s.chatwoot_token! } }
    );
    let contactId: number | null = null;
    if (searchRes.ok) {
      const j = await searchRes.json();
      const found = j.payload?.contacts?.[0] ?? (Array.isArray(j.payload) ? j.payload[0] : null);
      if (found?.id) contactId = found.id;
    }

    // Create contact if not found
    if (!contactId) {
      const createRes = await fetch(
        `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/contacts`,
        {
          method: "POST",
          headers: { api_access_token: s.chatwoot_token!, "Content-Type": "application/json" },
          body: JSON.stringify({ name: data.contactName, phone_number: normalizedPhone }),
        }
      );
      if (!createRes.ok) {
        const errBody = await createRes.text().catch(() => "");
        throw new Error(`Chatwoot create contact error: ${createRes.status} — ${errBody.slice(0, 200)}`);
      }
      const created = await createRes.json();
      // Handle both flat ({id: N}) and nested ({payload: {id: N}}) responses
      contactId = created.id ?? created.payload?.id ?? null;
    }

    if (!contactId) throw new Error("Não foi possível obter o ID do contato no Chatwoot");

    // Create conversation
    const convRes = await fetch(
      `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations`,
      {
        method: "POST",
        headers: { api_access_token: s.chatwoot_token!, "Content-Type": "application/json" },
        body: JSON.stringify({ inbox_id: inboxId, contact_id: contactId }),
      }
    );
    if (!convRes.ok) {
      const errBody = await convRes.text().catch(() => "");
      throw new Error(`Chatwoot create conversation error: ${convRes.status} — ${errBody.slice(0, 300)}`);
    }
    const conv = await convRes.json();

    // Send template message
    const msgRes = await fetch(
      `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations/${conv.id}/messages`,
      {
        method: "POST",
        headers: { api_access_token: s.chatwoot_token!, "Content-Type": "application/json" },
        body: JSON.stringify({
          content: data.templateBody,
          message_type: "outgoing",
          template_params: {
            name: data.templateName,
            category: data.category,
            language: data.language,
            processed_params: data.templateParams,
          },
        }),
      }
    );
    if (!msgRes.ok) throw new Error(`Chatwoot send template error: ${msgRes.status}`);

    // Auto-assign conversation to the agent who started it
    if (data.assigneeEmail) {
      const agentsRes = await fetch(
        `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/agents`,
        { headers: { api_access_token: s.chatwoot_token! } }
      );
      if (agentsRes.ok) {
        const agents: { id: number; email: string }[] = await agentsRes.json();
        const match = agents.find((a) => a.email === data.assigneeEmail);
        if (match) {
          await fetch(
            `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations/${conv.id}/assignments`,
            {
              method: "POST",
              headers: { api_access_token: s.chatwoot_token!, "Content-Type": "application/json" },
              body: JSON.stringify({ assignee_id: match.id }),
            }
          );
        }
      }
    }

    return { conversationId: conv.id as number };
  });

export const sendChatwootAttachment = createServerFn({ method: "POST" })
  .inputValidator((data: {
    conversationId: number;
    content: string;
    fileName: string;
    mimeType: string;
    base64: string;
  }) => data)
  .handler(async ({ data }) => {
    const s = await getChatwootSettings();
    const raw = data.base64.includes(",") ? data.base64.split(",")[1] : data.base64;
    const buffer = Buffer.from(raw, "base64");
    const formData = new FormData();
    if (data.content.trim()) formData.append("content", data.content);
    formData.append("message_type", "outgoing");
    formData.append(
      "attachments[]",
      new Blob([buffer], { type: data.mimeType }),
      data.fileName
    );
    const res = await fetch(
      `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations/${data.conversationId}/messages`,
      { method: "POST", headers: { api_access_token: s.chatwoot_token! }, body: formData }
    );
    if (!res.ok) throw new Error(`Chatwoot error: ${res.status}`);
    return await res.json();
  });

export const updateChatwootConversationStatus = createServerFn({ method: "POST" })
  .inputValidator((data: { conversationId: number; status: "open" | "pending" | "resolved" }) => data)
  .handler(async ({ data }) => {
    const s = await getChatwootSettings();
    const res = await fetch(
      `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations/${data.conversationId}/toggle_status`,
      {
        method: "POST",
        headers: {
          api_access_token: s.chatwoot_token!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: data.status }),
      }
    );
    if (!res.ok) throw new Error(`Chatwoot error: ${res.status}`);
    return await res.json();
  });
