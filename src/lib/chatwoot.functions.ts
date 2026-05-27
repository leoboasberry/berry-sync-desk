import { createServerFn } from "@tanstack/react-start";

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
