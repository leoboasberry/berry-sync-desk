import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { initialsOf } from "@/lib/utils";
import {
  searchHubSpotContacts,
  getMyHubSpotContacts,
  getAllHubSpotContacts,
} from "@/lib/hubspot.functions";
import {
  getChatwootTemplates,
  startConversationWithTemplate,
  getAllChatwootConversations,
} from "@/lib/chatwoot.functions";
import { supabase } from "@/integrations/supabase/client";
import {
  Search, Users, Loader2, MessageSquarePlus, MessageSquare, X, ChevronRight,
  ChevronUp, ChevronDown, ChevronsUpDown, Filter,
} from "lucide-react";

export const Route = createFileRoute("/contatos")({
  head: () => ({ meta: [{ title: "Contatos — Berry" }] }),
  component: () => (
    <AppShell>
      <ContatosPage />
    </AppShell>
  ),
});

// --- helpers ---

function extractVarCount(text: string): number {
  const matches = text.match(/\{\{(\d+)\}\}/g) ?? [];
  if (matches.length === 0) return 0;
  return Math.max(...matches.map((m) => parseInt(m.replace(/[{}]/g, ""))));
}

function fillTemplate(text: string, vars: string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (_, n) => vars[parseInt(n) - 1] ?? `{{${n}}}`);
}

function getBodyText(t: any): string {
  return t.components?.find((c: any) => c.type === "BODY")?.text ?? t.body ?? "";
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function lastNineDigits(phone: string): string {
  return phone.replace(/\D/g, "").slice(-9);
}

type SortField = "name" | "createdate" | "notes_last_updated";
type SortDir = "asc" | "desc";

// --- Template picker modal ---

function TemplateModal({
  contact,
  agentEmail,
  onClose,
  onStarted,
}: {
  contact: any;
  agentEmail: string;
  onClose: () => void;
  onStarted: (convId: number) => void;
}) {
  const [templates, setTemplates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<any | null>(null);
  const [vars, setVars] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getChatwootTemplates()
      .then(({ templates: t }) =>
        setTemplates(t.filter((tp: any) => tp.status?.toUpperCase() === "APPROVED"))
      )
      .catch((e: any) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  function selectTemplate(t: any) {
    const count = extractVarCount(getBodyText(t));
    setSelected(t);
    setVars(Array.from({ length: count }, () => ""));
    setError(null);
  }

  async function handleStart() {
    if (!selected) return;
    const phone = contact.properties?.phone ?? "";
    const name =
      [contact.properties?.firstname, contact.properties?.lastname].filter(Boolean).join(" ") ||
      "Contato";
    const body = fillTemplate(getBodyText(selected), vars);
    setStarting(true);
    setError(null);
    try {
      const { conversationId } = await startConversationWithTemplate({
        data: {
          phone,
          contactName: name,
          templateName: selected.name,
          templateParams: vars,
          language: selected.language ?? "pt_BR",
          category: selected.category ?? "MARKETING",
          templateBody: body,
          // assigneeEmail removed — agent identity resolved server-side from auth session
        },
      });
      onStarted(conversationId);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setStarting(false);
    }
  }

  const contactName =
    [contact.properties?.firstname, contact.properties?.lastname].filter(Boolean).join(" ") ||
    "Contato";

  const canStart = !!selected && vars.every((v) => v.trim() !== "");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="relative w-full max-w-lg rounded-[12px] bg-white dark:bg-[#1a1a1a] shadow-xl">
        <div className="flex items-center justify-between border-b border-[#e5e5e5] dark:border-[#2a2a2a] px-5 py-4">
          <div>
            <p className="text-[13px] text-[#666] dark:text-[#909090]">Iniciar conversa com</p>
            <p className="font-semibold text-[#090909] dark:text-[#e8e8e8]">{contactName}</p>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-[#666] dark:text-[#909090] hover:bg-[#f0f0f0] dark:hover:bg-[#252525]">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          {!selected ? (
            <>
              <p className="mb-3 text-sm font-medium text-[#090909] dark:text-[#e8e8e8]">Escolha o template</p>
              {loading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-[#c0c0c0] dark:text-[#505050]" />
                </div>
              ) : templates.length === 0 ? (
                <p className="py-6 text-center text-sm text-[#999] dark:text-[#686868]">
                  Nenhum template aprovado encontrado.
                </p>
              ) : (
                <div className="max-h-72 space-y-1.5 overflow-y-auto">
                  {templates.map((t) => (
                    <button
                      key={t.id ?? t.name}
                      onClick={() => selectTemplate(t)}
                      className="flex w-full items-center justify-between rounded-lg border border-[#e5e5e5] dark:border-[#2a2a2a] px-3.5 py-3 text-left hover:border-[#090909] dark:hover:border-[#555] hover:bg-[#fafafa] dark:hover:bg-[#1e1e1e]"
                    >
                      <div>
                        <p className="text-sm font-medium text-[#090909] dark:text-[#e8e8e8]">{t.name}</p>
                        <p className="mt-0.5 text-[12px] text-[#999] dark:text-[#686868]">
                          {t.category} · {t.language}
                        </p>
                      </div>
                      <ChevronRight className="h-4 w-4 shrink-0 text-[#ccc] dark:text-[#505050]" />
                    </button>
                  ))}
                </div>
              )}
              {error && <p className="mt-3 text-[12px] text-red-500">{error}</p>}
            </>
          ) : (
            <>
              <button
                onClick={() => { setSelected(null); setError(null); }}
                className="mb-3 text-[13px] text-[#666] dark:text-[#909090] hover:text-[#090909] dark:hover:text-[#e8e8e8]"
              >
                ← Voltar aos templates
              </button>

              <div className="mb-4 rounded-lg bg-[#f8f8f8] dark:bg-[#1e1e1e] px-3.5 py-3">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[#999] dark:text-[#686868]">
                  {selected.name}
                </p>
                <p className="whitespace-pre-wrap text-sm text-[#090909] dark:text-[#e8e8e8]">
                  {fillTemplate(getBodyText(selected), vars) || "—"}
                </p>
              </div>

              {vars.length > 0 && (
                <div className="mb-4 space-y-2">
                  {vars.map((v, i) => (
                    <div key={i}>
                      <label className="mb-1 block text-[12px] text-[#666] dark:text-[#909090]">
                        Variável {i + 1}
                      </label>
                      <Input
                        value={v}
                        onChange={(e) => {
                          const next = [...vars];
                          next[i] = e.target.value;
                          setVars(next);
                        }}
                        placeholder={`{{${i + 1}}}`}
                        className="h-9 text-sm"
                      />
                    </div>
                  ))}
                </div>
              )}

              {error && <p className="mb-3 text-[12px] text-red-500">{error}</p>}

              <Button
                onClick={handleStart}
                disabled={!canStart || starting}
                className="w-full bg-[#090909] text-white hover:bg-[#090909]/90"
              >
                {starting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <MessageSquarePlus className="mr-2 h-4 w-4" />
                )}
                Iniciar conversa
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Sortable column header ---

function SortTh({
  label,
  field,
  sortField,
  sortDir,
  onSort,
  className,
}: {
  label: string;
  field: SortField;
  sortField: SortField;
  sortDir: SortDir;
  onSort: (f: SortField) => void;
  className?: string;
}) {
  const active = field === sortField;
  return (
    <th
      onClick={() => onSort(field)}
      className={`cursor-pointer select-none px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-[#666] dark:text-[#909090] hover:text-[#090909] dark:hover:text-[#e8e8e8] ${className ?? ""}`}
    >
      <div className="flex items-center gap-1">
        {label}
        {active ? (
          sortDir === "asc" ? (
            <ChevronUp className="h-3 w-3 text-[#090909] dark:text-[#e8e8e8]" />
          ) : (
            <ChevronDown className="h-3 w-3 text-[#090909] dark:text-[#e8e8e8]" />
          )
        ) : (
          <ChevronsUpDown className="h-3 w-3 opacity-30" />
        )}
      </div>
    </th>
  );
}

function PlainTh({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-[#666] dark:text-[#909090] ${className ?? ""}`}>
      {children}
    </th>
  );
}

// --- Status badge ---

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  NEW: { bg: "#e8f5e9", text: "#2e7d32" },
  OPEN: { bg: "#e3f2fd", text: "#1565c0" },
  IN_PROGRESS: { bg: "#fff8e1", text: "#f57f17" },
  OPEN_DEAL: { bg: "#f3e5f5", text: "#6a1b9a" },
  CONNECTED: { bg: "#e0f7fa", text: "#006064" },
  UNQUALIFIED: { bg: "#fce4ec", text: "#880e4f" },
  ATTEMPTED_TO_CONTACT: { bg: "#fff3e0", text: "#e65100" },
  BAD_TIMING: { bg: "#f5f5f5", text: "#616161" },
};

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? { bg: "#f0f0f0", text: "#444" };
  return (
    <span
      className="inline-block rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ background: color.bg, color: color.text }}
    >
      {status}
    </span>
  );
}

// --- Main page ---

function ContatosPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [myContacts, setMyContacts] = useState<any[]>([]);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [loadingMy, setLoadingMy] = useState(true);
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [convModal, setConvModal] = useState<any | null>(null);
  const [agentEmail, setAgentEmail] = useState("");
  const [myRole, setMyRole] = useState<"admin" | "agent" | null>(null);
  const [convIndex, setConvIndex] = useState<Record<string, { id: number; status: "open" | "pending" | "resolved" }>>({});

  // Sort & filter
  const [sortField, setSortField] = useState<SortField>("createdate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [statusFilter, setStatusFilter] = useState("");

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) { setLoadingMy(false); return; }
      const { data: agent } = await supabase
        .from("agents")
        .select("hubspot_email, role")
        .eq("id", u.user.id)
        .maybeSingle();
      const role = ((agent as any)?.role ?? "agent") as "admin" | "agent";
      setMyRole(role);
      setAgentEmail(u.user.email || "");

      try {
        if (role === "admin") {
          const result = await getAllHubSpotContacts();
          setMyContacts(result);
        } else {
          const ownerEmail = (agent as any)?.hubspot_email || u.user.email || "";
          if (!ownerEmail) return;
          const result = await getMyHubSpotContacts({ data: { ownerEmail } });
          setMyContacts(result);
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoadingMy(false);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [open, pending, resolved] = await Promise.all([
          getAllChatwootConversations({ data: { status: "open" } }),
          getAllChatwootConversations({ data: { status: "pending" } }),
          getAllChatwootConversations({ data: { status: "resolved" } }),
        ]);
        const index: Record<string, { id: number; status: "open" | "pending" | "resolved" }> = {};
        const byStatus: [typeof open, "open" | "pending" | "resolved"][] = [
          [open, "open"],
          [pending, "pending"],
          [resolved, "resolved"],
        ];
        for (const [convs, status] of byStatus) {
          for (const c of convs) {
            const phone = c.meta?.sender?.phone_number ?? "";
            const key = lastNineDigits(phone);
            if (key && !index[key]) index[key] = { id: c.id, status };
          }
        }
        setConvIndex(index);
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

  useEffect(() => {
    if (!q.trim()) { setSearchResults([]); return; }
    const timer = setTimeout(() => {
      setLoadingSearch(true);
      searchHubSpotContacts({ data: { q: q.trim() } })
        .then(setSearchResults)
        .catch(console.error)
        .finally(() => setLoadingSearch(false));
    }, 400);
    return () => clearTimeout(timer);
  }, [q]);

  const rawContacts = q.trim() ? searchResults : myContacts;
  const loading = q.trim() ? loadingSearch : loadingMy;

  // Unique status values for filter
  const statusOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of myContacts) {
      const s = c.properties?.hs_lead_status;
      if (s) set.add(s);
    }
    return Array.from(set).sort();
  }, [myContacts]);

  // Sort + filter
  function handleSort(field: SortField) {
    if (field === sortField) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  }

  const contacts = useMemo(() => {
    let list = [...rawContacts];
    if (statusFilter) {
      list = list.filter((c) => c.properties?.hs_lead_status === statusFilter);
    }
    list.sort((a, b) => {
      if (sortField === "name") {
        const na = [a.properties?.firstname, a.properties?.lastname].filter(Boolean).join(" ").toLowerCase();
        const nb = [b.properties?.firstname, b.properties?.lastname].filter(Boolean).join(" ").toLowerCase();
        return sortDir === "asc" ? na.localeCompare(nb, "pt") : nb.localeCompare(na, "pt");
      }
      const va = a.properties?.[sortField] ?? "";
      const vb = b.properties?.[sortField] ?? "";
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [rawContacts, statusFilter, sortField, sortDir]);

  const isFiltered = !!statusFilter;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Top bar */}
      <div className="shrink-0 border-b border-[#e5e5e5] dark:border-[#2a2a2a] px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-[18px] font-bold text-[#090909] dark:text-[#e8e8e8]">
            Contatos
            {!loading && (
              <span className="ml-2 text-[14px] font-normal text-[#999] dark:text-[#686868]">
                {contacts.length}
              </span>
            )}
          </h1>

          <div className="flex flex-1 items-center gap-2 max-w-2xl">
            {/* Search */}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#666] dark:text-[#909090]" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Buscar por nome, empresa ou telefone…"
                className="h-9 pl-9 text-sm"
              />
            </div>

            {/* Status filter */}
            <div className="relative">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className={`h-9 rounded-md border px-3 pr-8 text-sm focus:outline-none focus:ring-1 focus:ring-[#090909] dark:focus:ring-[#888] appearance-none ${
                  isFiltered
                    ? "border-[#090909] dark:border-[#555] bg-[#090909] text-white"
                    : "border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] text-[#090909] dark:text-[#e8e8e8]"
                }`}
              >
                <option value="">Status CRM</option>
                {statusOptions.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <Filter className={`pointer-events-none absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2 ${isFiltered ? "text-white" : "text-[#666] dark:text-[#909090]"}`} />
            </div>

            {isFiltered && (
              <button
                onClick={() => setStatusFilter("")}
                className="flex items-center gap-1 text-[12px] text-[#666] dark:text-[#909090] hover:text-[#090909] dark:hover:text-[#e8e8e8]"
              >
                <X className="h-3 w-3" /> Limpar
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="overflow-hidden rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a]">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="border-b border-[#e5e5e5] dark:border-[#2a2a2a] bg-[#f8f8f8] dark:bg-[#1e1e1e]">
              <tr>
                <SortTh label="Nome" field="name" sortField={sortField} sortDir={sortDir} onSort={handleSort} className="w-[200px]" />
                <PlainTh className="w-[140px]">Empresa</PlainTh>
                <PlainTh className="w-[140px]">Telefone</PlainTh>
                <PlainTh className="w-[200px]">E-mail</PlainTh>
                <PlainTh className="w-[120px]">Status CRM</PlainTh>
                <SortTh label="Criado em" field="createdate" sortField={sortField} sortDir={sortDir} onSort={handleSort} className="w-[120px]" />
                <SortTh label="Últ. contato" field="notes_last_updated" sortField={sortField} sortDir={sortDir} onSort={handleSort} className="w-[120px]" />
                <PlainTh className="w-[180px]">{""}</PlainTh>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-16 text-center text-[#666] dark:text-[#909090]">
                    <Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin text-[#c0c0c0] dark:text-[#505050]" />
                  </td>
                </tr>
              ) : contacts.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-16 text-center text-[#666] dark:text-[#909090]">
                    <Users className="mx-auto mb-3 h-10 w-10 text-[#c0c0c0] dark:text-[#505050]" />
                    <p className="text-sm">
                      {q.trim()
                        ? "Nenhum contato encontrado."
                        : isFiltered
                        ? "Nenhum contato com esse status."
                        : myRole === "agent"
                        ? "Você não tem contatos atribuídos no HubSpot."
                        : "Nenhum contato encontrado."}
                    </p>
                  </td>
                </tr>
              ) : (
                contacts.map((c) => {
                  const firstName = c.properties?.firstname ?? "";
                  const lastName = c.properties?.lastname ?? "";
                  const name = [firstName, lastName].filter(Boolean).join(" ") || "Sem nome";
                  const company = c.properties?.company ?? "—";
                  const phone = c.properties?.phone ?? "—";
                  const email = c.properties?.email ?? "—";
                  const status = c.properties?.hs_lead_status;
                  const createDate = c.properties?.createdate;
                  const lastContact = c.properties?.notes_last_updated;

                  return (
                    <tr
                      key={c.id}
                      className="border-b border-[#e5e5e5] dark:border-[#2a2a2a] last:border-0 hover:bg-[#fafafa] dark:hover:bg-[#1e1e1e]"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <div
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
                            style={{ background: "#00e186", color: "#090909" }}
                          >
                            {initialsOf(name)}
                          </div>
                          <span className="truncate font-medium text-[#090909] dark:text-[#e8e8e8]" title={name}>{name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 max-w-[140px]">
                        <span className="block truncate text-[#090909] dark:text-[#e8e8e8]" title={company}>{company}</span>
                      </td>
                      <td className="px-4 py-3 text-[#666] dark:text-[#909090] whitespace-nowrap">{phone}</td>
                      <td className="px-4 py-3 max-w-[200px]">
                        <span className="block truncate text-[#666] dark:text-[#909090]" title={email}>{email}</span>
                      </td>
                      <td className="px-4 py-3">
                        {status ? <StatusBadge status={status} /> : <span className="text-[#999] dark:text-[#686868]">—</span>}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-[#666] dark:text-[#909090]">{fmtDate(createDate)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-[#666] dark:text-[#909090]">{fmtDate(lastContact)}</td>
                      <td className="px-4 py-3">
                        {(() => {
                          const key = phone !== "—" ? lastNineDigits(phone) : "";
                          const existingConv = key ? convIndex[key] : undefined;
                          return (
                            <div className="flex items-center justify-end gap-1.5">
                              {existingConv && (
                                <button
                                  onClick={() =>
                                    navigate({
                                      to: "/",
                                      search: { conversationId: existingConv.id, status: existingConv.status },
                                    })
                                  }
                                  className="flex items-center gap-1.5 rounded-lg bg-[#090909] px-2.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-[#090909]/90 whitespace-nowrap"
                                >
                                  <MessageSquare className="h-3.5 w-3.5" />
                                  Continuar
                                </button>
                              )}
                              {phone !== "—" && (!existingConv || existingConv.status === "resolved") && (
                                <button
                                  onClick={() => setConvModal(c)}
                                  className="flex items-center gap-1.5 rounded-lg border border-[#e5e5e5] dark:border-[#2a2a2a] px-2.5 py-1.5 text-[12px] font-medium text-[#090909] dark:text-[#e8e8e8] transition-colors hover:border-[#090909] dark:hover:border-[#555] hover:bg-[#090909] hover:text-white whitespace-nowrap"
                                >
                                  <MessageSquarePlus className="h-3.5 w-3.5" />
                                  Iniciar
                                </button>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {convModal && (
        <TemplateModal
          contact={convModal}
          agentEmail={agentEmail}
          onClose={() => setConvModal(null)}
          onStarted={() => {
            setConvModal(null);
            navigate({ to: "/" });
          }}
        />
      )}
    </div>
  );
}
