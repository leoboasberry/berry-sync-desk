import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn, initialsOf } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/configuracoes")({
  head: () => ({ meta: [{ title: "Configurações — Berry" }] }),
  component: () => (
    <AppShell>
      <ConfiguracoesPage />
    </AppShell>
  ),
});

type Tab = "account" | "integrations" | "agents";
const tabs: { key: Tab; label: string }[] = [
  { key: "account", label: "Minha conta" },
  { key: "integrations", label: "Integrações" },
  { key: "agents", label: "Agentes" },
];

function ConfiguracoesPage() {
  const [tab, setTab] = useState<Tab>("account");

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <h1 className="mb-6 text-[22px] font-bold text-[#090909]">Configurações</h1>

      <div className="mb-6 flex gap-6 border-b border-[#e5e5e5]">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "relative py-3 text-sm transition-colors",
              tab === t.key
                ? "font-semibold text-[#090909]"
                : "text-[#666] hover:text-[#090909]"
            )}
          >
            {t.label}
            {tab === t.key && (
              <span className="absolute -bottom-px left-0 right-0 h-0.5 bg-[#090909]" />
            )}
          </button>
        ))}
      </div>

      {tab === "account" && <AccountTab />}
      {tab === "integrations" && <IntegrationsTab />}
      {tab === "agents" && <AgentsTab />}
    </div>
  );
}

function AccountTab() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const { data } = await supabase
        .from("agents")
        .select("name, email")
        .eq("id", u.user.id)
        .maybeSingle();
      if (data) {
        setName(data.name ?? "");
        setEmail(data.email ?? u.user.email ?? "");
      } else {
        setEmail(u.user.email ?? "");
      }
    })();
  }, []);

  async function save() {
    setSaving(true);
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    const { error } = await supabase
      .from("agents")
      .upsert({ id: u.user.id, name, email })
      .eq("id", u.user.id);
    setSaving(false);
    if (error) toast.error(error.message);
    else toast.success("Conta atualizada");
  }

  return (
    <div className="rounded-[10px] border border-[#e5e5e5] bg-white p-6">
      <div className="mb-6 flex items-center gap-4">
        <div
          className="flex h-14 w-14 items-center justify-center rounded-full text-lg font-semibold"
          style={{ background: "#00e186", color: "#090909" }}
        >
          {initialsOf(name || email)}
        </div>
        <div>
          <div className="text-sm font-semibold text-[#090909]">Avatar</div>
          <div className="text-xs text-[#666]">Gerado a partir das iniciais.</div>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="label-uppercase">Nome</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label className="label-uppercase">E-mail</Label>
          <Input value={email} disabled />
        </div>
      </div>
      <div className="mt-6">
        <Button
          onClick={save}
          disabled={saving}
          className="bg-[#090909] text-white hover:bg-[#090909]/90"
        >
          {saving ? "Salvando…" : "Salvar"}
        </Button>
      </div>
    </div>
  );
}

function IntegrationsTab() {
  const [cwUrl, setCwUrl] = useState("");
  const [cwAccount, setCwAccount] = useState("");
  const [cwToken, setCwToken] = useState("");
  const [hsToken, setHsToken] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("settings").select("*").eq("id", 1).maybeSingle();
      if (data) {
        setCwUrl(data.chatwoot_url ?? "");
        setCwAccount(data.chatwoot_account_id ?? "");
        setCwToken(data.chatwoot_token ?? "");
        setHsToken(data.hubspot_token ?? "");
      }
    })();
  }, []);

  async function save() {
    setSaving(true);
    const { error } = await supabase.from("settings").upsert({
      id: 1,
      chatwoot_url: cwUrl,
      chatwoot_account_id: cwAccount,
      chatwoot_token: cwToken,
      hubspot_token: hsToken,
      updated_at: new Date().toISOString(),
    });
    setSaving(false);
    if (error) toast.error(error.message);
    else toast.success("Integrações salvas");
  }

  async function testChatwoot() {
    const url = cwUrl.trim().replace(/\/$/, "");
    const account = cwAccount.trim();
    const token = cwToken.trim();
    if (!url || !account || !token) {
      toast.error("Preencha URL, Account ID e Token");
      return;
    }
    const { error: saveErr } = await supabase.from("settings").upsert({
      id: 1,
      chatwoot_url: url,
      chatwoot_account_id: account,
      chatwoot_token: token,
      hubspot_token: hsToken,
      updated_at: new Date().toISOString(),
    });
    if (saveErr) {
      toast.error(`Falha ao salvar: ${saveErr.message}`);
      return;
    }
    try {
      const res = await fetch(`${url}/api/v1/profile`, {
        headers: { api_access_token: token },
      });
      if (res.ok) toast.success("Chatwoot: conexão OK");
      else toast.error(`Chatwoot: erro ${res.status}`);
    } catch {
      toast.error("Chatwoot: falha de rede");
    }
  }

  async function testHubspot() {
    if (!hsToken) {
      toast.error("Informe o Private App Token");
      return;
    }
    try {
      const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts?limit=1", {
        headers: { Authorization: `Bearer ${hsToken}` },
      });
      if (res.ok) toast.success("HubSpot: conexão OK");
      else toast.error(`HubSpot: erro ${res.status}`);
    } catch {
      toast.error("HubSpot: falha de rede");
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-[10px] border border-[#e5e5e5] bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[#090909]">Chatwoot</h3>
            <p className="text-xs text-[#666]">Motor de atendimento WhatsApp self-hosted.</p>
          </div>
          <Button size="sm" variant="outline" onClick={testChatwoot}>
            Testar conexão
          </Button>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="URL" value={cwUrl} onChange={setCwUrl} placeholder="https://chat.berry.com.br" />
          <Field label="Account ID" value={cwAccount} onChange={setCwAccount} placeholder="1" />
          <div className="sm:col-span-2">
            <Field label="API Token" value={cwToken} onChange={setCwToken} type="password" />
          </div>
        </div>
      </div>

      <div className="rounded-[10px] border border-[#e5e5e5] bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[#090909]">HubSpot</h3>
            <p className="text-xs text-[#666]">CRM para contatos, deals e notas.</p>
          </div>
          <Button size="sm" variant="outline" onClick={testHubspot}>
            Testar conexão
          </Button>
        </div>
        <Field label="Private App Token" value={hsToken} onChange={setHsToken} type="password" />
      </div>

      <Button
        onClick={save}
        disabled={saving}
        className="bg-[#090909] text-white hover:bg-[#090909]/90"
      >
        {saving ? "Salvando…" : "Salvar configurações"}
      </Button>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="label-uppercase">{label}</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type={type}
      />
    </div>
  );
}

type Agent = { id: string; name: string; email: string; status: string };
function AgentsTab() {
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("agents")
        .select("id, name, email, status")
        .order("created_at", { ascending: true });
      setAgents((data as Agent[]) ?? []);
    })();
  }, []);

  return (
    <div className="rounded-[10px] border border-[#e5e5e5] bg-white">
      <div className="flex items-center justify-between border-b border-[#e5e5e5] p-4">
        <h3 className="text-sm font-semibold text-[#090909]">Agentes</h3>
        <Button size="sm" className="bg-[#090909] text-white hover:bg-[#090909]/90">
          Convidar agente
        </Button>
      </div>
      <table className="w-full text-sm">
        <thead className="border-b border-[#e5e5e5] bg-[#f8f8f8]">
          <tr>
            <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-[#666]">
              Nome
            </th>
            <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-[#666]">
              E-mail
            </th>
            <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-[#666]">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {agents.length === 0 ? (
            <tr>
              <td colSpan={3} className="px-4 py-10 text-center text-[#666]">
                Nenhum agente ainda.
              </td>
            </tr>
          ) : (
            agents.map((a) => (
              <tr key={a.id} className="border-b border-[#e5e5e5] last:border-0">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div
                      className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold"
                      style={{ background: "#00e186", color: "#090909" }}
                    >
                      {initialsOf(a.name || a.email)}
                    </div>
                    <span className="font-medium text-[#090909]">{a.name || "—"}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-[#666]">{a.email}</td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1.5 text-xs text-[#090909]">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{
                        background:
                          a.status === "online"
                            ? "#00e186"
                            : a.status === "away"
                              ? "#f59e0b"
                              : "#d1d5db",
                      }}
                    />
                    {a.status}
                  </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
