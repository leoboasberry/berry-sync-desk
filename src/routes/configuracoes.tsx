import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn, initialsOf } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { testChatwootConnection, backfillConversationAssignments } from "@/lib/chatwoot.functions";
import {
  testHubspotConnection,
  getHubSpotProperties,
  getHubSpotVisibleFields,
  setHubSpotVisibleFields,
  DEFAULT_HS_FIELDS,
  type HsField,
} from "@/lib/hubspot.functions";
import { inviteAgent, updateAgent, removeAgent, resetAgentPassword } from "@/lib/agents.functions";
import { Search, Loader2, MoreVertical, Check, Copy } from "lucide-react";

function formatGroupName(g: string): string {
  const map: Record<string, string> = {
    contactinformation: "Informações do contato",
    leadinformation: "Informações de lead",
    emailinformation: "E-mail",
    socialmediainformation: "Redes sociais",
    conversioninformation: "Conversões",
    analyticshistory: "Analytics",
    hubspot_internal: "Interno HubSpot",
    callstoinformation: "Chamadas",
    loggingactivities: "Atividades",
    deals: "Negócios",
    closedrevenue: "Receita",
    salesproperties: "Vendas",
    recentactivities: "Atividades recentes",
  };
  return map[g] ?? g.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export const Route = createFileRoute("/configuracoes")({
  head: () => ({ meta: [{ title: "Configurações — Berry" }] }),
  component: () => (
    <AppShell>
      <ConfiguracoesPage />
    </AppShell>
  ),
});

type Tab = "account" | "integrations" | "agents" | "fields";
const tabs: { key: Tab; label: string }[] = [
  { key: "account", label: "Minha conta" },
  { key: "integrations", label: "Integrações" },
  { key: "agents", label: "Agentes" },
  { key: "fields", label: "Campos do Lead" },
];

function ConfiguracoesPage() {
  const [tab, setTab] = useState<Tab>("account");

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <h1 className="mb-6 text-[22px] font-bold text-[#090909] dark:text-[#e8e8e8]">Configurações</h1>

      <div className="mb-6 flex gap-6 border-b border-[#e5e5e5] dark:border-[#2a2a2a]">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "relative py-3 text-sm transition-colors",
              tab === t.key
                ? "font-semibold text-[#090909] dark:text-[#e8e8e8]"
                : "text-[#666] dark:text-[#909090] hover:text-[#090909] dark:hover:text-[#e8e8e8]"
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
      {tab === "fields" && <FieldsTab />}
    </div>
  );
}

function AccountTab() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [hubspotEmail, setHubspotEmail] = useState("");
  const [role, setRole] = useState("agent");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const { data } = await supabase
        .from("agents")
        .select("name, email, role, hubspot_email")
        .eq("id", u.user.id)
        .maybeSingle();
      if (data) {
        setName(data.name ?? "");
        setEmail(data.email ?? u.user.email ?? "");
        setRole((data as any).role ?? "agent");
        setHubspotEmail((data as any).hubspot_email ?? "");
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
      .upsert({ id: u.user.id, name, email, hubspot_email: hubspotEmail || null })
      .eq("id", u.user.id);
    setSaving(false);
    if (error) toast.error(error.message);
    else toast.success("Conta atualizada");
  }

  return (
    <div className="rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] p-6">
      <div className="mb-6 flex items-center gap-4">
        <div
          className="flex h-14 w-14 items-center justify-center rounded-full text-lg font-semibold"
          style={{ background: "#00e186", color: "#090909" }}
        >
          {initialsOf(name || email)}
        </div>
        <div>
          <div className="text-sm font-semibold text-[#090909] dark:text-[#e8e8e8]">{name || email}</div>
          <span
            className={cn(
              "mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold",
              role === "admin" ? "bg-[#090909] text-white" : "bg-[#f0f0f0] dark:bg-[#252525] text-[#666] dark:text-[#909090]"
            )}
          >
            {role === "admin" ? "Admin" : "Agente"}
          </span>
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
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="label-uppercase">E-mail no HubSpot</Label>
          <Input
            value={hubspotEmail}
            onChange={(e) => setHubspotEmail(e.target.value)}
            placeholder="Mesmo e-mail do seu usuário na HubSpot (se diferente do login)"
            type="email"
          />
          <p className="text-xs text-[#999] dark:text-[#686868]">
            Usado para encontrar os contatos atribuídos a você. Deixe em branco para usar o e-mail de login.
          </p>
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
      const result = await testChatwootConnection({ data: { url, token } });
      if (result.ok) toast.success("Chatwoot: conexão OK");
      else toast.error(`Chatwoot: ${result.status || "erro"} ${result.message}`);
    } catch (e) {
      toast.error(`Chatwoot: ${(e as Error).message}`);
    }
  }

  async function testHubspot() {
    const token = hsToken.trim();
    if (!token) {
      toast.error("Informe o Private App Token");
      return;
    }
    const { error: saveErr } = await supabase.from("settings").upsert({
      id: 1,
      chatwoot_url: cwUrl,
      chatwoot_account_id: cwAccount,
      chatwoot_token: cwToken,
      hubspot_token: token,
      updated_at: new Date().toISOString(),
    });
    if (saveErr) {
      toast.error(`Falha ao salvar: ${saveErr.message}`);
      return;
    }
    try {
      const result = await testHubspotConnection({ data: { token } });
      if (result.ok) toast.success("HubSpot: conexão OK");
      else toast.error(`HubSpot: ${result.status || "erro"} ${result.message}`);
    } catch (e) {
      toast.error(`HubSpot: ${(e as Error).message}`);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[#090909] dark:text-[#e8e8e8]">Chatwoot</h3>
            <p className="text-xs text-[#666] dark:text-[#909090]">Motor de atendimento WhatsApp self-hosted.</p>
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

      <div className="rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[#090909] dark:text-[#e8e8e8]">HubSpot</h3>
            <p className="text-xs text-[#666] dark:text-[#909090]">CRM para contatos, deals e notas.</p>
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

      <BackfillAssignmentsButton />
    </div>
  );
}

function BackfillAssignmentsButton() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ assigned: number; skipped: number } | null>(null);

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      const res = await backfillConversationAssignments({ data: { onlyUnassigned: true } });
      setResult(res);
      toast.success(`${res.assigned} conversa(s) atribuída(s)`);
    } catch (e: any) {
      toast.error(e?.message ?? "Erro ao executar atribuição retroativa");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-[#e5e5e5] dark:border-[#2a2a2a] p-4">
      <div className="text-sm font-semibold text-[#090909] dark:text-[#e8e8e8]">Atribuição retroativa de conversas</div>
      <p className="text-xs text-[#666] dark:text-[#909090]">
        Percorre todas as conversas sem atribuição e atribui ao agente que enviou a primeira mensagem.
      </p>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          onClick={run}
          disabled={running}
        >
          {running ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Executando…</> : "Executar agora"}
        </Button>
        {result && (
          <span className="text-xs text-[#666] dark:text-[#909090]">
            {result.assigned} atribuída(s) · {result.skipped} ignorada(s)
          </span>
        )}
      </div>
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

function FieldsTab() {
  const [properties, setProperties] = useState<Array<{ name: string; label: string; groupName: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    Promise.all([
      getHubSpotVisibleFields(),
      getHubSpotProperties(),
    ])
      .then(([saved, props]) => {
        const fields = saved ?? DEFAULT_HS_FIELDS;
        setSelected(new Set(fields.map((f) => f.name)));
        setProperties(
          props
            .filter((p) => p.fieldType !== "calculation_equation" && !p.name.startsWith("hs_analytics_"))
            .sort((a, b) => a.label.localeCompare(b.label, "pt"))
        );
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    const fields: HsField[] = properties
      .filter((p) => selected.has(p.name))
      .map((p) => ({ name: p.name, label: p.label }));
    try {
      await setHubSpotVisibleFields({ data: { fields } });
      toast.success(`${fields.length} campos salvos`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const filtered = properties.filter((p) => {
    const q = search.toLowerCase();
    return !q || p.label.toLowerCase().includes(q) || p.name.toLowerCase().includes(q);
  });

  const groups = filtered.reduce<Record<string, typeof filtered>>((acc, p) => {
    const g = p.groupName ?? "other";
    (acc[g] ??= []).push(p);
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <div className="rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[#090909] dark:text-[#e8e8e8]">Campos do Lead</h3>
            <p className="text-xs text-[#666] dark:text-[#909090]">
              Selecione quais propriedades do HubSpot aparecem no painel lateral da conversa.
            </p>
          </div>
          <span className="text-xs text-[#666] dark:text-[#909090]">{selected.size} selecionados</span>
        </div>

        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#999] dark:text-[#686868]" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar campo…"
            className="pl-9"
          />
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-[#999] dark:text-[#686868]" />
          </div>
        ) : error ? (
          <div className="rounded-lg bg-red-50 p-4 text-sm text-red-600">{error}</div>
        ) : (
          <div className="max-h-[500px] space-y-5 overflow-y-auto pr-1">
            {Object.entries(groups).map(([group, props]) => (
              <div key={group}>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[#999] dark:text-[#686868]">
                  {formatGroupName(group)}
                </div>
                <div className="divide-y divide-[#f0f0f0] dark:divide-[#2a2a2a]">
                  {props.map((p) => (
                    <label
                      key={p.name}
                      className="flex cursor-pointer items-center gap-3 py-2 px-1 hover:bg-[#f8f8f8] dark:hover:bg-[#1e1e1e] rounded-lg"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(p.name)}
                        onChange={() => toggle(p.name)}
                        className="h-4 w-4 shrink-0 accent-[#090909]"
                      />
                      <div className="min-w-0">
                        <div className="text-sm text-[#090909] dark:text-[#e8e8e8]">{p.label}</div>
                        <div className="text-[11px] text-[#999] dark:text-[#686868]">{p.name}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Button
        onClick={save}
        disabled={loading || saving}
        className="bg-[#090909] text-white hover:bg-[#090909]/90"
      >
        {saving ? "Salvando…" : "Salvar campos"}
      </Button>
    </div>
  );
}

type Agent = { id: string; name: string; email: string; status: string; role: string };

const STATUS_COLOR: Record<string, string> = {
  online: "#00e186",
  away: "#f59e0b",
  offline: "#d1d5db",
};

function AgentsTab() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [myId, setMyId] = useState("");
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [editTarget, setEditTarget] = useState<Agent | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);
  const [resetTarget, setResetTarget] = useState<Agent | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  const myAgent = agents.find((a) => a.id === myId);
  const isAdmin = myAgent?.role === "admin";

  async function load() {
    setLoading(true);
    const { data: u } = await supabase.auth.getUser();
    setMyId(u.user?.id ?? "");
    const { data } = await supabase
      .from("agents")
      .select("id, name, email, status, role")
      .order("created_at", { ascending: true });
    setAgents(((data ?? []) as any[]).map((a) => ({ ...a, role: a.role ?? "agent" })));
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  // close dropdown on outside click
  useEffect(() => {
    if (!menuOpenId) return;
    const close = () => setMenuOpenId(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuOpenId]);

  return (
    <div className="space-y-4">
      <div className="rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a]">
        <div className="flex items-center justify-between border-b border-[#e5e5e5] dark:border-[#2a2a2a] px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-[#090909] dark:text-[#e8e8e8]">Agentes</h3>
            {!isAdmin && !loading && (
              <p className="mt-0.5 text-xs text-[#999] dark:text-[#686868]">Apenas admins podem gerenciar agentes.</p>
            )}
          </div>
          {isAdmin && (
            <Button
              size="sm"
              className="bg-[#090909] text-white hover:bg-[#090909]/90"
              onClick={() => setShowInvite(true)}
            >
              + Convidar agente
            </Button>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-[#999] dark:text-[#686868]" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-[#e5e5e5] dark:border-[#2a2a2a] bg-[#f8f8f8] dark:bg-[#1e1e1e]">
              <tr>
                <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-[#666] dark:text-[#909090]">Nome</th>
                <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-[#666] dark:text-[#909090]">E-mail</th>
                <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-[#666] dark:text-[#909090]">Perfil</th>
                <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-[#666] dark:text-[#909090]">Status</th>
                {isAdmin && <th className="w-10 px-2 py-3" />}
              </tr>
            </thead>
            <tbody>
              {agents.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-10 text-center text-sm text-[#999] dark:text-[#686868]">
                    Nenhum agente cadastrado.
                  </td>
                </tr>
              ) : agents.map((a) => (
                <tr key={a.id} className="border-b border-[#e5e5e5] dark:border-[#2a2a2a] last:border-0">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <div
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
                        style={{ background: "#00e186", color: "#090909" }}
                      >
                        {initialsOf(a.name || a.email)}
                      </div>
                      <span className="font-medium text-[#090909] dark:text-[#e8e8e8]">
                        {a.name || "—"}
                        {a.id === myId && (
                          <span className="ml-1.5 text-[10px] font-normal text-[#999] dark:text-[#686868]">(você)</span>
                        )}
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-[#666] dark:text-[#909090]">{a.email}</td>
                  <td className="px-5 py-3">
                    <span className={cn(
                      "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold",
                      a.role === "admin" ? "bg-[#090909] text-white" : "bg-[#f0f0f0] dark:bg-[#252525] text-[#666] dark:text-[#909090]"
                    )}>
                      {a.role === "admin" ? "Admin" : "Agente"}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <span className="flex items-center gap-1.5 text-xs text-[#090909] dark:text-[#e8e8e8]">
                      <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[a.status] ?? "#d1d5db" }} />
                      {a.status ?? "offline"}
                    </span>
                  </td>
                  {isAdmin && (
                    <td className="relative px-2 py-3">
                      <button
                        onMouseDown={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === a.id ? null : a.id); }}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-[#999] dark:text-[#686868] hover:bg-[#f0f0f0] dark:hover:bg-[#252525] hover:text-[#090909] dark:hover:text-[#e8e8e8]"
                      >
                        <MoreVertical className="h-4 w-4" />
                      </button>
                      {menuOpenId === a.id && (
                        <div className="absolute right-2 top-10 z-20 w-44 rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] py-1 shadow-lg">
                          <button
                            onMouseDown={(e) => { e.stopPropagation(); setEditTarget(a); setMenuOpenId(null); }}
                            className="w-full px-4 py-2 text-left text-sm text-[#090909] dark:text-[#e8e8e8] hover:bg-[#f8f8f8] dark:hover:bg-[#1e1e1e]"
                          >
                            Editar
                          </button>
                          <button
                            onMouseDown={(e) => { e.stopPropagation(); setResetTarget(a); setMenuOpenId(null); }}
                            className="w-full px-4 py-2 text-left text-sm text-[#090909] dark:text-[#e8e8e8] hover:bg-[#f8f8f8] dark:hover:bg-[#1e1e1e]"
                          >
                            Redefinir senha
                          </button>
                          {a.id !== myId && (
                            <button
                              onMouseDown={(e) => { e.stopPropagation(); setDeleteTarget(a); setMenuOpenId(null); }}
                              className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                            >
                              Remover
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showInvite && (
        <AgentModal
          title="Adicionar agente"
          confirmLabel="Criar acesso"
          onClose={() => { setShowInvite(false); load(); }}
          onConfirm={async ({ name, email, role }) => {
            const result = await inviteAgent({ data: { name, email, role } });
            return result;
          }}
        />
      )}

      {editTarget && (
        <AgentModal
          title="Editar agente"
          confirmLabel="Salvar"
          initial={editTarget}
          emailReadOnly
          onClose={() => setEditTarget(null)}
          onConfirm={async ({ name, role }) => {
            await updateAgent({ data: { id: editTarget.id, name, role } });
            toast.success("Agente atualizado");
            load();
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmDeleteModal
          agent={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={async () => {
            await removeAgent({ data: { id: deleteTarget.id } });
            toast.success(`${deleteTarget.name || deleteTarget.email} removido`);
            load();
          }}
        />
      )}

      {resetTarget && (
        <ResetPasswordModal
          agent={resetTarget}
          onClose={() => setResetTarget(null)}
        />
      )}
    </div>
  );
}

function ResetPasswordModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [loading, setLoading] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function handleReset() {
    setLoading(true);
    setError("");
    try {
      const result = await resetAgentPassword({ data: { id: agent.id } });
      setTempPassword(result.tempPassword);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function copyPassword() {
    if (!tempPassword) return;
    navigator.clipboard.writeText(tempPassword);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div className="w-full max-w-md rounded-[14px] bg-white dark:bg-[#1a1a1a] p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        {tempPassword ? (
          <>
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-[#e8f5e9]">
              <Check className="h-5 w-5 text-[#2e7d32]" />
            </div>
            <h3 className="mb-1 text-base font-semibold text-[#090909] dark:text-[#e8e8e8]">Senha redefinida!</h3>
            <p className="mb-5 text-sm text-[#666] dark:text-[#909090]">
              Compartilhe as novas credenciais com <strong>{agent.name || agent.email}</strong>. O usuário já pode acessar.
            </p>
            <div className="space-y-3 rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a] bg-[#f8f8f8] dark:bg-[#1e1e1e] p-4">
              <div>
                <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wider text-[#999] dark:text-[#686868]">E-mail</p>
                <p className="text-sm text-[#090909] dark:text-[#e8e8e8]">{agent.email}</p>
              </div>
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[#999] dark:text-[#686868]">Nova senha temporária</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-md border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] px-3 py-2 font-mono text-sm font-bold text-[#090909] dark:text-[#e8e8e8] shadow-sm">
                    {tempPassword}
                  </code>
                  <button
                    onClick={copyPassword}
                    className="flex shrink-0 items-center gap-1.5 rounded-md border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] px-3 py-2 text-xs font-medium text-[#090909] dark:text-[#e8e8e8] hover:bg-[#f0f0f0] dark:hover:bg-[#252525]"
                  >
                    {copied
                      ? <><Check className="h-3.5 w-3.5 text-green-600" /> Copiado</>
                      : <><Copy className="h-3.5 w-3.5" /> Copiar</>}
                  </button>
                </div>
              </div>
            </div>
            <Button className="mt-5 w-full bg-[#090909] text-white hover:bg-[#090909]/90" onClick={onClose}>
              Fechar
            </Button>
          </>
        ) : (
          <>
            <h3 className="mb-1 text-base font-semibold text-[#090909] dark:text-[#e8e8e8]">Redefinir senha</h3>
            <p className="mb-5 text-sm text-[#666] dark:text-[#909090]">
              Uma nova senha temporária será gerada para{" "}
              <strong>{agent.name || agent.email}</strong>. O usuário também será ativado caso esteja inativo.
            </p>
            {error && <p className="mb-4 text-xs text-red-600">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose} disabled={loading}>Cancelar</Button>
              <Button
                className="bg-[#090909] text-white hover:bg-[#090909]/90"
                onClick={handleReset}
                disabled={loading}
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Gerar nova senha"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AgentModal({
  title,
  confirmLabel,
  initial,
  emailReadOnly = false,
  onClose,
  onConfirm,
}: {
  title: string;
  confirmLabel: string;
  initial?: Agent;
  emailReadOnly?: boolean;
  onClose: () => void;
  onConfirm: (data: { name: string; email: string; role: "admin" | "agent" }) => Promise<{ tempPassword: string } | void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [role, setRole] = useState<"admin" | "agent">((initial?.role as any) ?? "agent");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ tempPassword: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit() {
    if (!name.trim()) { setError("Informe o nome."); return; }
    if (!emailReadOnly && !email.trim()) { setError("Informe o e-mail."); return; }
    setLoading(true);
    setError("");
    try {
      const result = await onConfirm({ name: name.trim(), email: email.trim(), role });
      if (result?.tempPassword) {
        setDone(result);
      } else {
        onClose();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function copyPassword() {
    if (!done) return;
    navigator.clipboard.writeText(done.tempPassword);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (done) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="w-full max-w-md rounded-[14px] bg-white dark:bg-[#1a1a1a] p-6 shadow-2xl">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-[#e8f5e9]">
            <Check className="h-5 w-5 text-[#2e7d32]" />
          </div>
          <h3 className="mb-1 text-base font-semibold text-[#090909] dark:text-[#e8e8e8]">Agente criado!</h3>
          <p className="mb-5 text-sm text-[#666] dark:text-[#909090]">
            Compartilhe as credenciais abaixo com <strong>{name.trim()}</strong>. Ele pode trocar a senha após o primeiro acesso.
          </p>

          <div className="space-y-3 rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a] bg-[#f8f8f8] dark:bg-[#1e1e1e] p-4">
            <div>
              <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wider text-[#999] dark:text-[#686868]">E-mail</p>
              <p className="text-sm text-[#090909] dark:text-[#e8e8e8]">{email.trim()}</p>
            </div>
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[#999] dark:text-[#686868]">Senha temporária</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md bg-white dark:bg-[#1a1a1a] px-3 py-2 font-mono text-sm font-bold text-[#090909] dark:text-[#e8e8e8] shadow-sm border border-[#e5e5e5] dark:border-[#2a2a2a]">
                  {done.tempPassword}
                </code>
                <button
                  onClick={copyPassword}
                  className="flex shrink-0 items-center gap-1.5 rounded-md border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] px-3 py-2 text-xs font-medium text-[#090909] dark:text-[#e8e8e8] hover:bg-[#f0f0f0] dark:hover:bg-[#252525]"
                >
                  {copied
                    ? <><Check className="h-3.5 w-3.5 text-green-600" /> Copiado</>
                    : <><Copy className="h-3.5 w-3.5" /> Copiar</>}
                </button>
              </div>
            </div>
          </div>

          <Button className="mt-5 w-full bg-[#090909] text-white hover:bg-[#090909]/90" onClick={onClose}>
            Fechar
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div className="w-full max-w-md rounded-[14px] bg-white dark:bg-[#1a1a1a] p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <h3 className="mb-5 text-base font-semibold text-[#090909] dark:text-[#e8e8e8]">{title}</h3>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="label-uppercase">Nome</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome completo" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label className="label-uppercase">E-mail</Label>
            {emailReadOnly ? (
              <div className="flex h-10 items-center rounded-md border border-[#e5e5e5] dark:border-[#2a2a2a] bg-[#f8f8f8] dark:bg-[#1e1e1e] px-3 text-sm text-[#666] dark:text-[#909090]">
                {email}
              </div>
            ) : (
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@empresa.com" type="email" />
            )}
          </div>
          <div className="space-y-1.5">
            <Label className="label-uppercase">Perfil</Label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "admin" | "agent")}
              className="h-10 w-full rounded-md border border-[#e5e5e5] dark:border-[#2a2a2a] px-3 text-sm focus:outline-none focus:ring-1 focus:ring-[#090909] dark:focus:ring-[#888]"
            >
              <option value="agent">Agente — acesso padrão ao atendimento</option>
              <option value="admin">Admin — gerencia agentes e configurações</option>
            </select>
          </div>
        </div>
        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancelar</Button>
          <Button className="bg-[#090909] text-white hover:bg-[#090909]/90" onClick={submit} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConfirmDeleteModal({
  agent,
  onClose,
  onConfirm,
}: {
  agent: Agent;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function confirm() {
    setLoading(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div className="w-full max-w-sm rounded-[14px] bg-white dark:bg-[#1a1a1a] p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <h3 className="mb-2 text-base font-semibold text-[#090909] dark:text-[#e8e8e8]">Remover agente</h3>
        <p className="text-sm text-[#666] dark:text-[#909090]">
          Tem certeza que deseja remover <strong>{agent.name || agent.email}</strong>?
          O acesso será revogado imediatamente.
        </p>
        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancelar</Button>
          <Button
            className="bg-red-600 text-white hover:bg-red-700"
            onClick={confirm}
            disabled={loading}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Remover"}
          </Button>
        </div>
      </div>
    </div>
  );
}
