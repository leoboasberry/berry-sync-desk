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

function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const d = raw.replace(/\D/g, "");
  // Canonical Brazilian format: 55 + 2-digit area + 9-digit mobile = 13 digits
  // 13 digits starting with 55 → already canonical
  if (d.length === 13 && d.startsWith("55")) return d;
  // 12 digits starting with 55 (old 8-digit number) → insert 9th digit after area code
  if (d.length === 12 && d.startsWith("55")) return d.slice(0, 4) + "9" + d.slice(4);
  // 11 digits (area + 9-digit, missing country code) → prepend 55
  if (d.length === 11) return "55" + d;
  // 10 digits (area + 8-digit, missing country code and 9th digit) → prepend 55, insert 9
  if (d.length === 10) return "55" + d.slice(0, 2) + "9" + d.slice(2);
  return d;
}

async function upsertMessagesToHistory(msgs: any[], contactPhone: string, conversationId: number) {
  if (!msgs.length || !contactPhone) return;
  const phone = normalizePhone(contactPhone);
  const rows = msgs
    .filter((m) => m.message_type !== 2) // skip activity messages
    .map((m) => ({
      chatwoot_message_id: m.id as number,
      conversation_id: conversationId,
      contact_phone: phone,
      message_type: m.message_type as number,
      content: (m.content as string) ?? null,
      status: (m.status as string) ?? null,
      content_attributes: m.content_attributes ?? {},
      attachments: m.attachments ?? [],
      sender_name: (m.sender?.name as string) ?? null,
      sender_type: (m.sender?.type as string) ?? null,
      created_at_chatwoot: new Date((m.created_at as number) * 1000).toISOString(),
    }));
  if (!rows.length) return;
  await (supabaseAdmin as any)
    .from("messages_history")
    .upsert(rows, { onConflict: "chatwoot_message_id", ignoreDuplicates: false });
}

export const getChatwootMessages = createServerFn({ method: "POST" })
  .inputValidator((data: { conversationId: number; contactPhone?: string }) => data)
  .handler(async ({ data }) => {
    const s = await getChatwootSettings();
    const res = await fetch(
      `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations/${data.conversationId}/messages`,
      { headers: { api_access_token: s.chatwoot_token! } }
    );
    if (!res.ok) throw new Error(`Chatwoot error: ${res.status}`);
    const json = await res.json();
    const msgs = (json.payload ?? []) as any[];
    // Proactively sync to history if phone is provided
    if (data.contactPhone) {
      await upsertMessagesToHistory(msgs, data.contactPhone, data.conversationId);
    }
    return msgs;
  });

export const getContactHistory = createServerFn({ method: "POST" })
  .inputValidator((data: { contactPhone: string }) => data)
  .handler(async ({ data }) => {
    const phone = normalizePhone(data.contactPhone);
    const { data: rows, error } = await (supabaseAdmin as any)
      .from("messages_history")
      .select("*")
      .eq("contact_phone", phone)
      .order("created_at_chatwoot", { ascending: true });
    if (error) throw new Error(error.message);
    return (rows ?? []) as any[];
  });

export const backfillContactHistory = createServerFn({ method: "POST" })
  .inputValidator((data: { contactPhone: string }) => data)
  .handler(async ({ data }) => {
    const s = await getChatwootSettings();
    const phone = normalizePhone(data.contactPhone);
    // Search contact conversations by phone across all statuses
    let total = 0;
    for (const status of ["open", "resolved", "pending"] as const) {
      let page = 1;
      while (true) {
        const res = await fetch(
          `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations?status=${status}&page=${page}`,
          { headers: { api_access_token: s.chatwoot_token! } }
        );
        if (!res.ok) break;
        const json = await res.json();
        const convs: any[] = json.data?.payload ?? [];
        if (!convs.length) break;
        for (const conv of convs) {
          const convPhone = normalizePhone(conv.meta?.sender?.phone_number);
          if (convPhone !== phone) continue;
          // Fetch all messages for this conversation (paginated)
          let before: number | undefined;
          while (true) {
            const url = `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations/${conv.id}/messages${before ? `?before=${before}` : ""}`;
            const mRes = await fetch(url, { headers: { api_access_token: s.chatwoot_token! } });
            if (!mRes.ok) break;
            const mJson = await mRes.json();
            const msgs: any[] = mJson.payload ?? [];
            if (!msgs.length) break;
            await upsertMessagesToHistory(msgs, phone, conv.id);
            total += msgs.filter((m) => m.message_type !== 2).length;
            // If we got fewer than the max page size, we're done
            if (msgs.length < 20) break;
            before = Math.min(...msgs.map((m) => m.id));
          }
        }
        if (convs.length < 25) break;
        page++;
      }
    }
    return { synced: total };
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

export const retryChatwootMessage = createServerFn({ method: "POST" })
  .inputValidator((data: { conversationId: number; messageId: number }) => data)
  .handler(async ({ data }) => {
    const s = await getChatwootSettings();
    const res = await fetch(
      `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations/${data.conversationId}/messages/${data.messageId}/retry`,
      { method: "POST", headers: { api_access_token: s.chatwoot_token! } }
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

export const backfillConversationAssignments = createServerFn({ method: "POST" })
  .inputValidator((data: { onlyUnassigned?: boolean }) => data)
  .handler(async ({ data }) => {
    const s = await getChatwootSettings();

    // Load all agents once
    const agentsRes = await fetch(
      `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/agents`,
      { headers: { api_access_token: s.chatwoot_token! } }
    );
    if (!agentsRes.ok) throw new Error("Erro ao carregar agentes");
    const agents: { id: number; name: string; email: string }[] = await agentsRes.json();

    let assigned = 0;
    let skipped = 0;

    for (const status of ["open", "pending", "resolved"] as const) {
      let page = 1;
      while (true) {
        const res = await fetch(
          `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations?status=${status}&page=${page}`,
          { headers: { api_access_token: s.chatwoot_token! } }
        );
        if (!res.ok) break;
        const json = await res.json();
        const convs: any[] = json.data?.payload ?? [];
        if (!convs.length) break;

        for (const conv of convs) {
          // Skip if already assigned and onlyUnassigned is true
          if (data.onlyUnassigned !== false && conv.meta?.assignee?.id) {
            skipped++;
            continue;
          }

          // Fetch messages to find first outgoing sender
          const msgRes = await fetch(
            `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations/${conv.id}/messages`,
            { headers: { api_access_token: s.chatwoot_token! } }
          );
          if (!msgRes.ok) continue;
          const msgJson = await msgRes.json();
          const msgs: any[] = (msgJson.payload ?? []).filter((m: any) => m.message_type === 1);
          if (!msgs.length) { skipped++; continue; }

          // First outgoing message — sender is the agent
          const firstOut = msgs.sort((a: any, b: any) => (a.created_at ?? 0) - (b.created_at ?? 0))[0];
          const senderName: string = firstOut.sender?.name ?? "";
          const senderEmail: string = firstOut.sender?.email ?? "";

          const match = agents.find((a) =>
            (senderEmail && a.email === senderEmail) ||
            (senderName && a.name === senderName)
          );
          if (!match) { skipped++; continue; }

          await fetch(
            `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations/${conv.id}/assignments`,
            {
              method: "POST",
              headers: { api_access_token: s.chatwoot_token!, "Content-Type": "application/json" },
              body: JSON.stringify({ assignee_id: match.id }),
            }
          );
          assigned++;
        }

        if (convs.length < 25) break;
        page++;
      }
    }

    return { assigned, skipped };
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

    const digits = normalizedPhone.replace(/\D/g, "");
    const last9 = digits.slice(-9);

    // Helper: extract contact id from Chatwoot search response (v2 and v3 formats)
    function extractContactId(j: any): number | null {
      const found =
        j.payload?.contacts?.[0] ??
        (Array.isArray(j.payload) ? j.payload[0] : null) ??
        j.results?.[0] ??
        null;
      return found?.id ?? null;
    }

    // Helper: search contacts by query term
    async function searchContact(q: string): Promise<number | null> {
      const r = await fetch(
        `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/contacts/search?q=${encodeURIComponent(q)}&include_contacts=true`,
        { headers: { api_access_token: s.chatwoot_token! } }
      );
      if (!r.ok) return null;
      return extractContactId(await r.json());
    }

    // 1st: search by normalized phone
    let contactId: number | null = await searchContact(normalizedPhone);

    // 2nd: search by last 9 digits if not found (phone stored in different format)
    if (!contactId) contactId = await searchContact(last9);

    // 3rd: create contact if still not found
    if (!contactId) {
      const createRes = await fetch(
        `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/contacts`,
        {
          method: "POST",
          headers: { api_access_token: s.chatwoot_token!, "Content-Type": "application/json" },
          body: JSON.stringify({ name: data.contactName, phone_number: normalizedPhone }),
        }
      );

      if (createRes.ok) {
        const created = await createRes.json();
        // Try all known response formats: flat, {payload:{id}}, {payload:{contact:{id}}}
        contactId =
          created.id ??
          created.payload?.id ??
          created.payload?.contact?.id ??
          created.contact?.id ??
          null;
      }

      // If create failed (e.g. 422 = already exists) or returned no ID, search again
      if (!contactId) {
        contactId = await searchContact(normalizedPhone);
        if (!contactId) contactId = await searchContact(last9);
      }

      if (!contactId) {
        const errBody = createRes.ok ? "" : await createRes.text().catch(() => "");
        throw new Error(`Não foi possível criar/encontrar o contato no Chatwoot${errBody ? ` (${createRes.status}: ${errBody.slice(0, 150)})` : ""}`);
      }
    }

    // Reuse an existing open/pending conversation with this contact in this inbox, if any,
    // instead of creating a duplicate one.
    let conv: { id: number } | null = null;
    const existingRes = await fetch(
      `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/contacts/${contactId}/conversations`,
      { headers: { api_access_token: s.chatwoot_token! } }
    );
    if (existingRes.ok) {
      const existingJson = await existingRes.json();
      const existingConvs: any[] = existingJson.payload ?? [];
      const reusable = existingConvs
        .filter((c) => c.inbox_id === inboxId && (c.status === "open" || c.status === "pending"))
        .sort((a, b) => (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0))[0];
      if (reusable) conv = { id: reusable.id };
    }

    if (!conv) {
      // Create contact_inbox so Chatwoot has a source_id (phone) to send WhatsApp messages
      let contactInboxId: number | null = null;
      const ciRes = await fetch(
        `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/contacts/${contactId}/contact_inboxes`,
        {
          method: "POST",
          headers: { api_access_token: s.chatwoot_token!, "Content-Type": "application/json" },
          body: JSON.stringify({ inbox_id: inboxId }),
        }
      );
      if (ciRes.ok) {
        const ci = await ciRes.json();
        contactInboxId = ci.payload?.id ?? ci.id ?? null;
      }

      // Create conversation
      const convBody: Record<string, any> = { inbox_id: inboxId, contact_id: contactId };
      if (contactInboxId) convBody.contact_inbox_id = contactInboxId;
      const convRes = await fetch(
        `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations`,
        {
          method: "POST",
          headers: { api_access_token: s.chatwoot_token!, "Content-Type": "application/json" },
          body: JSON.stringify(convBody),
        }
      );
      if (!convRes.ok) {
        const errBody = await convRes.text().catch(() => "");
        throw new Error(`Chatwoot create conversation error: ${convRes.status} — ${errBody.slice(0, 300)}`);
      }
      conv = await convRes.json();
    }
    const conversationId = conv!.id;

    // Send template message
    const msgRes = await fetch(
      `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations/${conversationId}/messages`,
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
            // Chatwoot requires a hash {1: val, 2: val}, not an array
            processed_params: Object.fromEntries(
              data.templateParams.map((v, i) => [String(i + 1), v])
            ),
          },
        }),
      }
    );
    if (!msgRes.ok) {
      const errBody = await msgRes.text().catch(() => "");
      throw new Error(`Chatwoot send template error: ${msgRes.status} — ${errBody.slice(0, 400)}`);
    }

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
            `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations/${conversationId}/assignments`,
            {
              method: "POST",
              headers: { api_access_token: s.chatwoot_token!, "Content-Type": "application/json" },
              body: JSON.stringify({ assignee_id: match.id }),
            }
          );
        }
      }
    }

    return { conversationId };
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

export const markConversationRead = createServerFn({ method: "POST" })
  .inputValidator((data: { conversationId: number }) => data)
  .handler(async ({ data }) => {
    const s = await getChatwootSettings();
    await fetch(
      `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations/${data.conversationId}/update_last_seen`,
      { method: "POST", headers: { api_access_token: s.chatwoot_token! } }
    );
    return { ok: true };
  });

export const markConversationUnread = createServerFn({ method: "POST" })
  .inputValidator((data: { conversationId: number }) => data)
  .handler(async ({ data }) => {
    const s = await getChatwootSettings();
    await fetch(
      `${s.url}/api/v1/accounts/${s.chatwoot_account_id}/conversations/${data.conversationId}/unread`,
      { method: "POST", headers: { api_access_token: s.chatwoot_token! } }
    );
    return { ok: true };
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
