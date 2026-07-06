import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type HsField = { name: string; label: string; referencedObjectType?: string };
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
    const contact = r1 ?? await (async () => {
      // 2nd try: CONTAINS_TOKEN on phone + mobilephone (OR) with last 9 digits
      const token9 = allDigits.slice(-9);
      return search({
        filterGroups: [
          { filters: [{ propertyName: "phone", operator: "CONTAINS_TOKEN", value: token9 }] },
          { filters: [{ propertyName: "mobilephone", operator: "CONTAINS_TOKEN", value: token9 }] },
        ],
      });
    })();

    if (!contact) return null;

    // Merge Lead properties — Lead object owns fields like pre_sales_owner, hubspot_owner_id
    try {
      const assocRes = await fetch(
        `https://api.hubapi.com/crm/v4/objects/contacts/${contact.id}/associations/leads`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (assocRes.ok) {
        const assocJson = await assocRes.json();
        const leadId = assocJson?.results?.[0]?.toObjectId;
        if (leadId) {
          const leadRes = await fetch(
            `https://api.hubapi.com/crm/v3/objects/leads/${leadId}?properties=${properties.join(",")}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (leadRes.ok) {
            const leadJson = await leadRes.json();
            // Lead properties override contact properties for matching keys
            const leadProps = leadJson.properties ?? {};
            contact.properties = { ...contact.properties };
            for (const key of Object.keys(leadProps)) {
              if (leadProps[key] != null) contact.properties[key] = leadProps[key];
            }
          }
        }
      }
    } catch {
      // Lead merge is best-effort — don't fail the whole request
    }

    return contact;
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

export const getHubSpotOwners = createServerFn({ method: "POST" })
  .handler(async () => {
    const token = await getHsToken();
    const res = await fetch(
      "https://api.hubapi.com/crm/v3/owners?limit=200",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return [] as Array<{ id: string; firstName: string; lastName: string; email: string }>;
    const json = await res.json();
    return (json.results ?? []) as Array<{ id: string; firstName: string; lastName: string; email: string }>;
  });

// Upsert lead owner for a phone into the cache (called after loading HubSpot contact)
export const upsertContactOwnerCache = createServerFn({ method: "POST" })
  .inputValidator((data: { phone: string; hubspot_owner_id: string | null }) => data)
  .handler(async ({ data }) => {
    await (supabaseAdmin as any)
      .from("contact_owner_cache")
      .upsert({ phone: data.phone, hubspot_owner_id: data.hubspot_owner_id, updated_at: new Date().toISOString() }, { onConflict: "phone" });
  });

// Batch-load owner cache for a list of phones
export const getContactOwnersBatch = createServerFn({ method: "POST" })
  .inputValidator((data: { phones: string[] }) => data)
  .handler(async ({ data }) => {
    if (!data.phones.length) return [] as Array<{ phone: string; hubspot_owner_id: string | null }>;
    const { data: rows } = await (supabaseAdmin as any)
      .from("contact_owner_cache")
      .select("phone, hubspot_owner_id")
      .in("phone", data.phones);
    return (rows ?? []) as Array<{ phone: string; hubspot_owner_id: string | null }>;
  });

export const debugHubSpotContact = createServerFn({ method: "POST" })
  .inputValidator((data: { contactId: string; properties: string[] }) => data)
  .handler(async ({ data }) => {
    const token = await getHsToken();

    // 1. Fetch contact properties via contacts API
    const contactRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${data.contactId}?properties=${data.properties.join(",")}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const contactJson = contactRes.ok ? await contactRes.json() : { error: contactRes.status };

    // 2. Try leads API — find lead associated with this contact
    const leadsRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/leads?limit=10`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const leadsAvailable = leadsRes.status !== 404 && leadsRes.status !== 403;

    // 3. Fetch lead associated with contact
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v4/objects/contacts/${data.contactId}/associations/leads`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const assocJson = assocRes.ok ? await assocRes.json() : null;
    const leadId = assocJson?.results?.[0]?.toObjectId ?? null;

    let leadProps: any = null;
    if (leadId) {
      const leadRes = await fetch(
        `https://api.hubapi.com/crm/v3/objects/leads/${leadId}?properties=${data.properties.join(",")}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      leadProps = leadRes.ok ? await leadRes.json() : { error: leadRes.status };
    }

    return {
      contactProperties: contactJson?.properties ?? {},
      leadsAvailable,
      leadId,
      leadProperties: leadProps?.properties ?? null,
    };
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
      referencedObjectType?: string;
    }>;
  });
