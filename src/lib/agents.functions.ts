import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

function generateTempPassword(): string {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let pwd = "Berry@";
  for (let i = 0; i < 6; i++) {
    pwd += chars[Math.floor(Math.random() * chars.length)];
  }
  return pwd;
}

export const inviteAgent = createServerFn({ method: "POST" })
  .inputValidator((data: { name: string; email: string; role: "admin" | "agent" }) => data)
  .handler(async ({ data }) => {
    const tempPassword = generateTempPassword();
    const { data: userData, error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { name: data.name },
    });
    if (error) throw new Error(error.message);
    const userId = userData.user.id;
    const { error: dbErr } = await supabaseAdmin.from("agents").upsert({
      id: userId,
      name: data.name,
      email: data.email,
      role: data.role,
      status: "offline",
    });
    if (dbErr) throw new Error(dbErr.message);
    return { id: userId, tempPassword };
  });

export const resetAgentPassword = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const tempPassword = generateTempPassword();
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.id, {
      password: tempPassword,
      ban_duration: "none",
      email_confirm: true,
    } as any);
    if (error) throw new Error(error.message);
    return { tempPassword };
  });

export const updateAgent = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string; name: string; role: "admin" | "agent"; chatwoot_token?: string }) => data)
  .handler(async ({ data }) => {
    const { error } = await supabaseAdmin
      .from("agents")
      .update({
        name: data.name,
        role: data.role,
        ...(data.chatwoot_token !== undefined ? { chatwoot_token: data.chatwoot_token || null } : {}),
      } as any)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
  });

export const removeAgent = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const { error } = await supabaseAdmin.from("agents").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    await supabaseAdmin.auth.admin.updateUserById(data.id, {
      ban_duration: "876600h",
    });
  });
