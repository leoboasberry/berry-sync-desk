import { createServerFn } from "@tanstack/react-start";

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
