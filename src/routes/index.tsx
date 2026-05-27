import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn, initialsOf, timeAgo } from "@/lib/utils";
import { mockConversations, type MockConversation } from "@/lib/mockData";
import {
  Search,
  Send,
  ExternalLink,
  MessageCircle,
  Phone,
  UserPlus,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Atendimento — Berry" }] }),
  component: () => (
    <AppShell>
      <AtendimentoPage />
    </AppShell>
  ),
});

type Tab = "open" | "pending" | "resolved";
const tabs: { key: Tab; label: string }[] = [
  { key: "open", label: "Abertas" },
  { key: "pending", label: "Pendentes" },
  { key: "resolved", label: "Resolvidas" },
];

function AtendimentoPage() {
  const [tab, setTab] = useState<Tab>("open");
  const [search, setSearch] = useState("");
  const [activeId, setActiveId] = useState<number | null>(mockConversations[0].id);
  const [draft, setDraft] = useState("");

  const visible = useMemo(
    () =>
      mockConversations.filter(
        (c) =>
          c.status === tab &&
          (search === "" ||
            c.contact.name.toLowerCase().includes(search.toLowerCase()) ||
            c.preview.toLowerCase().includes(search.toLowerCase()))
      ),
    [tab, search]
  );

  const active = mockConversations.find((c) => c.id === activeId) ?? null;

  return (
    <div className="flex h-[calc(100vh-52px)]">
      {/* Left: conversation list */}
      <aside
        className="flex w-[300px] flex-col border-r border-[#e5e5e5]"
        style={{ background: "#f8f8f8" }}
      >
        <div className="border-b border-[#e5e5e5] p-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#666]" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar conversas"
              className="h-9 bg-white pl-8"
            />
          </div>
        </div>
        <div className="flex gap-5 border-b border-[#e5e5e5] px-3">
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
        <div className="flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#666]">Sem conversas</div>
          ) : (
            visible.map((c) => (
              <ConversationRow
                key={c.id}
                conv={c}
                active={c.id === activeId}
                onClick={() => setActiveId(c.id)}
              />
            ))
          )}
        </div>
      </aside>

      {/* Center: chat */}
      <section className="flex flex-1 flex-col bg-white">
        {!active ? (
          <EmptyChat />
        ) : (
          <>
            <header className="flex items-center justify-between border-b border-[#e5e5e5] px-6 py-3">
              <div className="flex items-center gap-3">
                <div
                  className="flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold"
                  style={{ background: "#00e186", color: "#090909" }}
                >
                  {initialsOf(active.contact.name)}
                </div>
                <div>
                  <div className="text-sm font-semibold text-[#090909]">
                    {active.contact.name}
                  </div>
                  <div className="text-xs text-[#666]">{active.contact.phone}</div>
                </div>
                <StatusBadge status={active.status} />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="bg-[#00e186] text-[#090909] hover:bg-[#00c875]"
                >
                  Resolver
                </Button>
                <Button size="sm" variant="outline">
                  Pendente
                </Button>
                <Button
                  size="sm"
                  className="bg-[#090909] text-white hover:bg-[#090909]/90"
                >
                  Atribuir
                </Button>
              </div>
            </header>

            <div className="flex-1 space-y-3 overflow-y-auto px-6 py-5">
              {active.messages.map((m) => (
                <div
                  key={m.id}
                  className={cn(
                    "flex",
                    m.from === "agent" ? "justify-end" : "justify-start"
                  )}
                >
                  <div className="max-w-[70%]">
                    <div
                      className={cn(
                        "rounded-2xl px-4 py-2.5 text-sm",
                        m.from === "agent"
                          ? "bg-[#090909] text-white"
                          : "border border-[#e5e5e5] bg-[#f8f8f8] text-[#090909]"
                      )}
                    >
                      {m.text}
                    </div>
                    <div
                      className={cn(
                        "mt-1 text-[11px] text-[#666]",
                        m.from === "agent" ? "text-right" : "text-left"
                      )}
                    >
                      {timeAgo(m.at)} atrás
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-end gap-2 border-t border-[#e5e5e5] px-6 py-4">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Digite uma mensagem…"
                className="h-11"
              />
              <Button
                size="icon"
                className="h-11 w-11 bg-[#090909] text-white hover:bg-[#090909]/90"
                onClick={() => setDraft("")}
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </>
        )}
      </section>

      {/* Right: lead panel */}
      <aside
        className="w-[320px] overflow-y-auto border-l border-[#e5e5e5] p-4"
        style={{ background: "#f8f8f8" }}
      >
        {active ? <LeadPanel conv={active} /> : null}
      </aside>
    </div>
  );
}

function ConversationRow({
  conv,
  active,
  onClick,
}: {
  conv: MockConversation;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-3 border-b border-[#e5e5e5] px-3 py-3 text-left transition-colors",
        active ? "bg-white" : "hover:bg-white/60"
      )}
    >
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
        style={{ background: "#00e186", color: "#090909" }}
      >
        {initialsOf(conv.contact.name)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold text-[#090909]">
            {conv.contact.name}
          </span>
          <span className="shrink-0 text-[11px] text-[#666]">{timeAgo(conv.updatedAt)}</span>
        </div>
        <p className="mt-0.5 truncate text-xs text-[#666]">{conv.preview}</p>
      </div>
      {conv.unread && (
        <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: "#00e186" }} />
      )}
    </button>
  );
}

function StatusBadge({ status }: { status: MockConversation["status"] }) {
  const map = {
    open: { label: "Aberta", bg: "#e6fff6", fg: "#00a86b" },
    pending: { label: "Pendente", bg: "#fff4dc", fg: "#b45309" },
    resolved: { label: "Resolvida", bg: "#f0f0f0", fg: "#666" },
  } as const;
  const s = map[status];
  return (
    <span
      className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
      style={{ background: s.bg, color: s.fg }}
    >
      {s.label}
    </span>
  );
}

function LeadPanel({ conv }: { conv: MockConversation }) {
  return (
    <div className="space-y-3">
      <div className="rounded-[10px] border border-[#e5e5e5] bg-white p-4">
        <div className="label-uppercase mb-3">Contato</div>
        <div className="space-y-2.5 text-sm">
          <Field label="Nome" value={conv.contact.name} />
          <Field label="Telefone" value={conv.contact.phone} />
          {conv.contact.email && <Field label="E-mail" value={conv.contact.email} />}
          {conv.contact.company && <Field label="Empresa" value={conv.contact.company} />}
        </div>
      </div>

      <div className="rounded-[10px] border border-[#e5e5e5] bg-white p-4">
        <div className="label-uppercase mb-3">Deal ativo</div>
        <div className="space-y-2">
          <div className="text-sm font-semibold text-[#090909]">Renovação franquia 2026</div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-[#f0f0f0] px-2 py-0.5 text-[11px] font-medium text-[#444]">
              Proposta enviada
            </span>
            <span className="text-xs text-[#666]">R$ 24.500</span>
          </div>
          <div className="mt-2">
            <div className="mb-1 flex justify-between text-[11px] text-[#666]">
              <span>Progresso</span>
              <span>60%</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-[#e5e5e5]">
              <div className="h-full rounded-full bg-[#00e186]" style={{ width: "60%" }} />
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-[10px] border border-[#e5e5e5] bg-white p-4">
        <div className="label-uppercase mb-3">Últimas interações</div>
        <div className="space-y-3">
          <Interaction icon="chat" text="Mensagem recebida via WhatsApp" when="3 min" />
          <Interaction icon="call" text="Ligação concluída (8min)" when="2h" />
          <Interaction icon="chat" text="Conversa resolvida" when="1d" />
        </div>
      </div>

      <Button variant="outline" className="w-full">
        <ExternalLink className="mr-2 h-3.5 w-3.5" />
        Ver no HubSpot
      </Button>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label-uppercase mb-0.5">{label}</div>
      <div className="font-medium text-[#090909]">{value}</div>
    </div>
  );
}

function Interaction({ icon, text, when }: { icon: "chat" | "call"; text: string; when: string }) {
  const Ico = icon === "chat" ? MessageCircle : Phone;
  const color = icon === "chat" ? "#00e186" : "#0034ff";
  return (
    <div className="flex items-start gap-3">
      <div
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        style={{ background: `${color}1a`, color }}
      >
        <Ico className="h-3.5 w-3.5" />
      </div>
      <div className="flex-1">
        <div className="truncate text-xs text-[#090909]">{text}</div>
        <div className="text-[11px] text-[#666]">{when} atrás</div>
      </div>
    </div>
  );
}

function EmptyChat() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center text-sm text-[#666]">
      <UserPlus className="mb-3 h-10 w-10 text-[#c0c0c0]" />
      Selecione uma conversa para começar
    </div>
  );
}
