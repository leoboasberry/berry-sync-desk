import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type HsField = { name: string; label: string };
export const DEFAULT_HS_FIELDS: HsField[] = [
  { name: "firstname", label: "Primeiro nome" },
  { name: "lastname", label: "Sobrenome" },
  { name: "company", label: "Empresa" },
  { name: "phone", label: "Telefone" },
  { name: "email", label: "E-mail" },
  { name: "hs_lead_status", label: "Status do lead" },
];

export const testHubspotConnection = createServerFn({ method: "POST" })
  .inputValidator((data: { token: string }) => data)
  .handler(async ({ data }) => {
    const token = data.token.trim();
    if (!token) {
      return { ok: false, status: 0, message: "Token vazio" };
    }
    try {
      const res = await fetch(
        "https://api.hubapi.com/crm/v3/objects/contacts?limit=1",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );
      if (res.ok) {
        return { ok: true, status: res.status, message: "OK" };
      }
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        message: body.slice(0, 200) || res.statusText,
      };
    } catch (e) {
      return { ok: false, status: 0, message: (e as Error).message };
    }
  });

async function getHsToken(): Promise<string> {
  const { data } = await supabaseAdmin
    .from("settings")
    .select("hubspot_token")
    .eq("id", 1)
    .single();
  if (!data?.hubspot_token) throw new Error("HubSpot não configurado");
  return data.hubspot_token;
}

export const searchHubSpotContacts = createServerFn({ method: "POST" })
  .inputValidator((data: { q: string }) => data)
  .handler(async ({ data }) => {
    const token = await getHsToken();
    const body: Record<string, any> = {
      properties: [
        "firstname", "lastname", "company", "phone", "email",
        "hs_lead_status", "notes_last_updated",
      ],
      limit: 50,
    };
    if (data.q.trim()) body.query = data.q.trim();
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HubSpot error: ${res.status}`);
    const json = await res.json();
    return (json.results ?? []) as any[];
  });

const HS_CONTACT_PROPS = [
  "firstname", "lastname", "company", "phone", "email",
  "hs_lead_status", "notes_last_updated", "createdate",
];

export const getMyHubSpotContacts = createServerFn({ method: "POST" })
  .inputValidator((data: { ownerEmail: string }) => data)
  .handler(async ({ data }) => {
    const token = await getHsToken();

    const ownerRes = await fetch(
      `https://api.hubapi.com/crm/v3/owners?email=${encodeURIComponent(data.ownerEmail)}&limit=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!ownerRes.ok) throw new Error(`HubSpot owners error: ${ownerRes.status}`);
    const ownerJson = await ownerRes.json();
    const owner = ownerJson.results?.[0];
    if (!owner) return [] as any[];

    const all: any[] = [];
    let after: string | undefined;
    do {
      const body: Record<string, any> = {
        filterGroups: [{
          filters: [{ propertyName: "hubspot_owner_id", operator: "EQ", value: String(owner.id) }],
        }],
        properties: HS_CONTACT_PROPS,
        limit: 200,
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      };
      if (after) body.after = after;
      const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HubSpot error: ${res.status}`);
      const json = await res.json();
      all.push(...(json.results ?? []));
      after = json.paging?.next?.after;
    } while (after);
    return all;
  });

export const getAllHubSpotContacts = createServerFn({ method: "POST" })
  .handler(async () => {
    const token = await getHsToken();
    const all: any[] = [];
    let after: string | undefined;
    do {
      const body: Record<string, any> = {
        properties: HS_CONTACT_PROPS,
        limit: 200,
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      };
      if (after) body.after = after;
      const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HubSpot error: ${res.status}`);
      const json = await res.json();
      all.push(...(json.results ?? []));
      after = json.paging?.next?.after;
    } while (after);
    return all;
  });

export const getHubSpotContactByPhone = createServerFn({ method: "POST" })
  .inputValidator((data: { phone: string; properties?: string[] }) => data)
  .handler(async ({ data }) => {
    const token = await getHsToken();
    const allDigits = data.phone.replace(/\D/g, "");
    if (!allDigits) return null;

    // Remove Brazilian country code (55) to get local number (DDD + number)
    const localPhone = allDigits.startsWith("55") && allDigits.length > 10
      ? allDigits.slice(2)
      : allDigits;

    const properties = data.properties?.length
      ? data.properties
      : ["firstname", "lastname", "company", "phone", "email", "hs_lead_status"];

    const search = async (body: object) => {
      const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...body, properties, limit: 1 }),
      });
      if (!res.ok) return null;
      const json = await res.json();
      return (json.results?.[0] ?? null) as any;
    };

    // 1st try: full-text query with local number (DDD + digits) — most robust
    const r1 = await search({ query: localPhone });
    if (r1) return r1;

    // 2nd try: CONTAINS_TOKEN on phone + mobilephone (OR) with last 9 digits
    const token9 = allDigits.slice(-9);
    const r2 = await search({
      filterGroups: [
        { filters: [{ propertyName: "phone", operator: "CONTAINS_TOKEN", value: token9 }] },
        { filters: [{ propertyName: "mobilephone", operator: "CONTAINS_TOKEN", value: token9 }] },
      ],
    });
    return r2;
  });

export const getHubSpotVisibleFields = createServerFn({ method: "POST" })
  .handler(async () => {
    const { data } = await supabaseAdmin
      .from("settings")
      .select("hubspot_visible_fields")
      .eq("id", 1)
      .single();
    return (data?.hubspot_visible_fields as HsField[] | null) ?? null;
  });

export const setHubSpotVisibleFields = createServerFn({ method: "POST" })
  .inputValidator((data: { fields: HsField[] }) => data)
  .handler(async ({ data }) => {
    await supabaseAdmin
      .from("settings")
      .upsert({ id: 1, hubspot_visible_fields: data.fields });
  });

export const getHubSpotContactNotes = createServerFn({ method: "POST" })
  .inputValidator((data: { contactId: string }) => data)
  .handler(async ({ data }) => {
    const token = await getHsToken();
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/notes/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        filterGroups: [{
          filters: [{ propertyName: "associations.contact", operator: "EQ", value: data.contactId }],
        }],
        properties: ["hs_note_body", "hs_timestamp"],
        sorts: [{ propertyName: "hs_timestamp", direction: "DESCENDING" }],
        limit: 20,
      }),
    });
    if (!res.ok) return [] as any[];
    const json = await res.json();
    return (json.results ?? []) as any[];
  });

export const createHubSpotNote = createServerFn({ method: "POST" })
  .inputValidator((data: { contactId: string; body: string }) => data)
  .handler(async ({ data }) => {
    const token = await getHsToken();
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        properties: {
          hs_note_body: data.body,
          hs_timestamp: new Date().toISOString(),
        },
        associations: [{
          to: { id: data.contactId },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
        }],
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message ?? `HubSpot error: ${res.status}`);
    }
    return await res.json();
  });

export const getHubSpotProperties = createServerFn({ method: "POST" })
  .handler(async () => {
    const token = await getHsToken();
    const res = await fetch(
      "https://api.hubapi.com/crm/v3/properties/contacts?archived=false",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`HubSpot error: ${res.status}`);
    const json = await res.json();
    return (json.results ?? []) as Array<{
      name: string;
      label: string;
      type: string;
      fieldType: string;
      groupName: string;
    }>;
  });
