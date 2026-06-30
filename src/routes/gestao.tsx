import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { getAllChatwootConversations } from "@/lib/chatwoot.functions";
import { supabase } from "@/integrations/supabase/client";
import { cn, initialsOf } from "@/lib/utils";
import {
  Loader2, RefreshCw, Users, Clock, AlertTriangle,
  MessageCircle, UserX, TrendingUp, Filter, X,
} from "lucide-react";

export const Route = createFileRoute("/gestao")({
  head: () => ({ meta: [{ title: "Visão do Gestor — Berry" }] }),
  component: () => (
    <AppShell>
      <GestaoPage />
    </AppShell>
  ),
});

// ─── Constants ───────────────────────────────────────────────────────────────

const SLA_SECONDS = 30 * 60; // 30 min

// ─── Types ───────────────────────────────────────────────────────────────────

type AgentRow = { id: string; name: string; status: string };
type Priority = "high" | "medium" | "low";
type OverloadLevel = "normal" | "attention" | "overload";

// ─── Time helpers ─────────────────────────────────────────────────────────────

function nowTs() { return Math.floor(Date.now() / 1000); }

function todayStartTs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function toUnix(v: number | string | undefined): number {
  if (!v) return 0;
  if (typeof v === "string") return Math.floor(new Date(v).getTime() / 1000);
  return v;
}

function fmtWait(secs: number): string {
  if (secs < 60) return "agora";
  if (secs < 3600) return `${Math.floor(secs / 60)}min`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function fmtTime(ts: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

// ─── Conversation analysis ────────────────────────────────────────────────────

function convLastMsgTs(conv: any): number {
  return toUnix(conv.last_message?.created_at ?? conv.last_activity_at);
}

function convCreatedTs(conv: any): number {
  return toUnix(conv.created_at);
}

function isWaiting(conv: any): boolean {
  return conv.last_message?.message_type === 0;
}

function convWaitSecs(conv: any): number {
  if (!isWaiting(conv)) return 0;
  return Math.max(0, nowTs() - convLastMsgTs(conv));
}

function isSlaBreached(conv: any): boolean {
  return isWaiting(conv) && convWaitSecs(conv) > SLA_SECONDS;
}

function isNewToday(conv: any): boolean {
  return convCreatedTs(conv) >= todayStartTs();
}

function convPriority(conv: any): Priority {
  if (isSlaBreached(conv)) return "high";
  const s = convWaitSecs(conv);
  if (s > 900 || isWaiting(conv)) return "medium"; // >15min waiting
  return "low";
}

function overloadLevel(count: number): OverloadLevel {
  if (count > 10) return "overload";
  if (count >= 6) return "attention";
  return "normal";
}

// ─── Visual constants ─────────────────────────────────────────────────────────

const STATUS_DOT: Record<string, string> = {
  online: "#00e186",
  away: "#f59e0b",
  offline: "#d1d5db",
};

const PRIORITY_DOT: Record<Priority, string> = {
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#d1d5db",
};

const OVERLOAD: Record<OverloadLevel, { border: string; badge: string; label: string; labelColor: string }> = {
  normal:    { border: "#e5e5e5",  badge: "#090909", label: "",           labelColor: "#999" },
  attention: { border: "#f59e0b",  badge: "#f59e0b", label: "Atenção",    labelColor: "#b45309" },
  overload:  { border: "#ef4444",  badge: "#ef4444", label: "Sobrecarga", labelColor: "#dc2626" },
};

// ─── StatCard ─────────────────────────────────────────────────────────────────

function StatCard({
  label, value, icon: Icon, danger, active, onClick,
}: {
  label: string; value: number; icon: React.ElementType;
  danger?: boolean; active?: boolean; onClick?: () => void;
}) {
  const isAlert = danger && value > 0;
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        "flex w-full flex-col items-start gap-1 rounded-[10px] border px-4 py-3 text-left transition-all",
        onClick && "hover:shadow-sm",
        active   ? "border-[#090909] bg-[#090909]"
        : isAlert ? "border-red-200 bg-red-50"
        :           "border-[#e5e5e5] bg-white",
        !onClick && "cursor-default"
      )}
    >
      <div className="flex items-center gap-1.5">
        <Icon className={cn("h-3.5 w-3.5",
          active ? "text-white/70" : isAlert ? "text-red-500" : "text-[#999]")} />
        <span className={cn("text-[10px] font-semibold uppercase tracking-wider",
          active ? "text-white/70" : isAlert ? "text-red-500" : "text-[#999]")}>
          {label}
        </span>
      </div>
      <span className={cn("text-[28px] font-bold leading-none",
        active ? "text-white" : isAlert ? "text-red-600" : "text-[#090909]")}>
        {value}
      </span>
    </button>
  );
}

// ─── ConvCard ─────────────────────────────────────────────────────────────────

function ConvCard({ conv, onClick }: { conv: any; onClick: () => void }) {
  const name = conv.meta?.sender?.name ?? "Contato";
  const waiting = isWaiting(conv);
  const sla = isSlaBreached(conv);
  const prio = convPriority(conv);
  const isPending = conv.status === "pending";
  const lastTs = convLastMsgTs(conv);
  const elapsed = lastTs ? nowTs() - lastTs : 0;
  const isNew = isNewToday(conv);

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full rounded-[8px] border p-3 text-left transition-all hover:shadow-sm",
        sla     ? "border-red-200 bg-red-50 hover:border-red-300"
        : waiting ? "border-amber-200 bg-amber-50 hover:border-amber-300"
        :           "border-[#e5e5e5] bg-white hover:border-[#090909]"
      )}
    >
      {/* Top row: priority dot + name + badges */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="mt-1 h-2 w-2 shrink-0 rounded-full"
            style={{ background: PRIORITY_DOT[prio] }}
            title={prio === "high" ? "Alta prioridade" : prio === "medium" ? "Média" : "Baixa"}
          />
          <div className="flex min-w-0 items-center gap-1.5">
            <div
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold"
              style={{ background: "#00e186", color: "#090909" }}
            >
              {initialsOf(name)}
            </div>
            <span className="truncate text-[13px] font-medium text-[#090909]">{name}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {isNew && (
            <span className="rounded-full bg-[#090909] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">
              Novo
            </span>
          )}
          <span className={cn(
            "rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
            isPending ? "bg-amber-100 text-amber-700" : "bg-green-100 text-green-700"
          )}>
            {isPending ? "Pendente" : "Aberta"}
          </span>
        </div>
      </div>

      {/* Middle: time + who sent last */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-[#999]">
          {elapsed ? `${fmtWait(elapsed)} atrás` : "—"}
        </span>
        {waiting ? (
          <span className="flex items-center gap-1 text-[10px] font-semibold text-amber-600">
            <Clock className="h-2.5 w-2.5" />
            Lead aguardando
          </span>
        ) : (
          <span className="text-[10px] text-[#bbb]">SDR respondeu</span>
        )}
      </div>

      {/* SLA alert */}
      {sla && (
        <div className="mt-2 flex items-center gap-1 rounded-md bg-red-100 px-2 py-1">
          <AlertTriangle className="h-3 w-3 text-red-500" />
          <span className="text-[10px] font-semibold text-red-600">
            SLA estourado há {fmtWait(convWaitSecs(conv))}
          </span>
        </div>
      )}
    </button>
  );
}

// ─── AgentColumn ─────────────────────────────────────────────────────────────

function AgentColumn({
  assignee, convs, supaAgent, isUnassigned, onConvClick,
}: {
  assignee: any; convs: any[]; supaAgent?: AgentRow;
  isUnassigned: boolean; onConvClick: (conv: any) => void;
}) {
  const name = isUnassigned ? "Não atribuído" : (assignee?.name ?? "Desconhecido");
  const level = isUnassigned ? "normal" as OverloadLevel : overloadLevel(convs.length);
  const style = OVERLOAD[level];
  const dotColor = isUnassigned ? "#d1d5db" : STATUS_DOT[supaAgent?.status ?? "offline"];

  const waitingCount = convs.filter(isWaiting).length;
  const slaCount = convs.filter(isSlaBreached).length;

  const sorted = [...convs].sort((a, b) => {
    const pa = isSlaBreached(a) ? 3 : isWaiting(a) ? 2 : isNewToday(a) ? 1 : 0;
    const pb = isSlaBreached(b) ? 3 : isWaiting(b) ? 2 : isNewToday(b) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0);
  });

  return (
    <div
      className="flex w-[272px] shrink-0 flex-col overflow-hidden rounded-[12px] border"
      style={{ borderColor: isUnassigned ? "#f59e0b" : style.border }}
    >
      {/* Header */}
      <div
        className="shrink-0 border-b px-4 py-3"
        style={{ background: "#f9f9f9", borderColor: isUnassigned ? "#f59e0b44" : "#f0f0f0" }}
      >
        {/* Name row */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="relative shrink-0">
              <div
                className="flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-bold"
                style={{ background: isUnassigned ? "#e5e5e5" : "#090909", color: isUnassigned ? "#999" : "#fff" }}
              >
                {isUnassigned ? "?" : initialsOf(name)}
              </div>
              {!isUnassigned && (
                <span
                  className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white"
                  style={{ background: dotColor }}
                />
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-[#090909]">{name}</p>
              {!isUnassigned && level !== "normal" && (
                <p className="text-[10px] font-medium" style={{ color: style.labelColor }}>
                  {style.label}
                </p>
              )}
            </div>
          </div>
          <span
            className="ml-1 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold text-white"
            style={{ background: isUnassigned ? "#f59e0b" : style.badge }}
          >
            {convs.length}
          </span>
        </div>

        {/* Mini-metrics */}
        {!isUnassigned && (waitingCount > 0 || slaCount > 0) && (
          <div className="mt-2.5 flex items-center gap-3 border-t border-[#f0f0f0] pt-2">
            {waitingCount > 0 && (
              <div className="flex items-center gap-1">
                <Clock className="h-3 w-3 text-amber-500" />
                <span className="text-[10px] font-medium text-amber-600">{waitingCount} aguardando</span>
              </div>
            )}
            {slaCount > 0 && (
              <div className="flex items-center gap-1">
                <AlertTriangle className="h-3 w-3 text-red-500" />
                <span className="text-[10px] font-medium text-red-600">{slaCount} SLA estourado</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Conv cards */}
      <div className="flex flex-col gap-2 overflow-y-auto bg-white p-3">
        {sorted.length === 0 ? (
          <p className="py-6 text-center text-[11px] text-[#bbb]">Sem conversas</p>
        ) : (
          sorted.map(conv => (
            <ConvCard key={conv.id} conv={conv} onClick={() => onConvClick(conv)} />
          ))
        )}
      </div>
    </div>
  );
}

// ─── FilterChip ───────────────────────────────────────────────────────────────

function FilterChip({
  label, active, count, danger, onClick,
}: {
  label: string; active: boolean; count?: number; danger?: boolean; onClick: () => void;
}) {
  const hasAlert = danger && (count ?? 0) > 0;
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition-all",
        active
          ? hasAlert ? "border-red-500 bg-red-500 text-white"
                     : "border-[#090909] bg-[#090909] text-white"
          : hasAlert ? "border-red-200 bg-red-50 text-red-600 hover:border-red-400"
                     : "border-[#e5e5e5] bg-white text-[#090909] hover:border-[#090909]"
      )}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span className={cn(
          "rounded-full px-1.5 text-[10px] font-bold",
          active ? "bg-white/25 text-white" : hasAlert ? "bg-red-100 text-red-700" : "bg-[#f0f0f0] text-[#666]"
        )}>
          {count}
        </span>
      )}
    </button>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

function GestaoPage() {
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<any[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Filters
  const [filterSDR, setFilterSDR] = useState("");
  const [filterToday, setFilterToday] = useState(false);
  const [filterWaiting, setFilterWaiting] = useState(false);
  const [filterSLA, setFilterSLA] = useState(false);
  const [filterUnassigned, setFilterUnassigned] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [open, pending, { data: agentsData }] = await Promise.all([
        getAllChatwootConversations({ data: { status: "open" } }),
        getAllChatwootConversations({ data: { status: "pending" } }),
        supabase.from("agents").select("id, name, status").order("name"),
      ]);
      setConversations([...open, ...pending]);
      setAgents((agentsData ?? []) as AgentRow[]);
      setLastUpdated(new Date());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Global stats (ignoring filters)
  const stats = useMemo(() => {
    const today = todayStartTs();
    return {
      newToday:   conversations.filter(c => convCreatedTs(c) >= today).length,
      inProgress: conversations.length,
      unassigned: conversations.filter(c => !c.meta?.assignee).length,
      waiting:    conversations.filter(isWaiting).length,
      slaBreached: conversations.filter(isSlaBreached).length,
    };
  }, [conversations]);

  // Filtered conversations for kanban
  const filtered = useMemo(() => {
    return conversations.filter(c => {
      if (filterToday && !isNewToday(c)) return false;
      if (filterWaiting && !isWaiting(c)) return false;
      if (filterSLA && !isSlaBreached(c)) return false;
      if (filterUnassigned && c.meta?.assignee) return false;
      if (filterSDR) {
        const assigneeId = String(c.meta?.assignee?.id ?? "");
        if (filterSDR === "__unassigned__") {
          if (c.meta?.assignee) return false;
        } else if (assigneeId !== filterSDR) return false;
      }
      return true;
    });
  }, [conversations, filterToday, filterWaiting, filterSLA, filterUnassigned, filterSDR]);

  // Group by assignee
  const groups = useMemo(() => {
    const map: Record<string, { assignee: any; convs: any[] }> = {};
    for (const c of filtered) {
      const key = c.meta?.assignee ? String(c.meta.assignee.id) : "__unassigned__";
      if (!map[key]) map[key] = { assignee: c.meta?.assignee ?? null, convs: [] };
      map[key].convs.push(c);
    }
    return map;
  }, [filtered]);

  const sortedKeys = useMemo(() =>
    Object.keys(groups).sort((a, b) => {
      if (a === "__unassigned__") return 1;
      if (b === "__unassigned__") return -1;
      // Sort: overloaded agents first, then by conv count
      const la = overloadLevel(groups[a].convs.length);
      const lb = overloadLevel(groups[b].convs.length);
      const order = { overload: 2, attention: 1, normal: 0 };
      if (order[la] !== order[lb]) return order[lb] - order[la];
      return groups[b].convs.length - groups[a].convs.length;
    }),
  [groups]);

  const activeFilterCount = [filterToday, filterWaiting, filterSLA, filterUnassigned, !!filterSDR].filter(Boolean).length;

  function clearFilters() {
    setFilterToday(false);
    setFilterWaiting(false);
    setFilterSLA(false);
    setFilterUnassigned(false);
    setFilterSDR("");
  }

  function handleConvClick(_conv: any) {
    navigate({ to: "/" });
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">

      {/* ── Header ── */}
      <div className="flex shrink-0 items-center justify-between border-b border-[#e5e5e5] px-6 py-4">
        <div>
          <h1 className="text-[18px] font-bold text-[#090909]">Visão do Gestor</h1>
          {lastUpdated && (
            <p className="mt-0.5 text-[12px] text-[#999]">
              Atualizado às {lastUpdated.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
            </p>
          )}
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 rounded-lg border border-[#e5e5e5] px-3 py-1.5 text-sm text-[#090909] hover:bg-[#f5f5f5] disabled:opacity-50"
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          Atualizar
        </button>
      </div>

      {/* ── Stats bar ── */}
      <div className="shrink-0 border-b border-[#e5e5e5] px-6 py-3">
        <div className="grid grid-cols-5 gap-3">
          <StatCard
            label="Novos hoje"
            value={stats.newToday}
            icon={TrendingUp}
            active={filterToday}
            onClick={() => setFilterToday(v => !v)}
          />
          <StatCard
            label="Em atendimento"
            value={stats.inProgress}
            icon={MessageCircle}
          />
          <StatCard
            label="Sem responsável"
            value={stats.unassigned}
            icon={UserX}
            danger={stats.unassigned > 0}
            active={filterUnassigned}
            onClick={() => setFilterUnassigned(v => !v)}
          />
          <StatCard
            label="Aguardando SDR"
            value={stats.waiting}
            icon={Clock}
            active={filterWaiting}
            onClick={() => setFilterWaiting(v => !v)}
          />
          <StatCard
            label="SLA estourado"
            value={stats.slaBreached}
            icon={AlertTriangle}
            danger={stats.slaBreached > 0}
            active={filterSLA}
            onClick={() => setFilterSLA(v => !v)}
          />
        </div>
      </div>

      {/* ── Filter bar ── */}
      <div className="shrink-0 border-b border-[#e5e5e5] px-6 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-[#bbb]">
            <Filter className="h-3 w-3" />
            Filtrar
          </span>

          <select
            value={filterSDR}
            onChange={e => setFilterSDR(e.target.value)}
            className="h-7 rounded-full border border-[#e5e5e5] bg-white px-3 text-[12px] text-[#090909] focus:outline-none focus:ring-1 focus:ring-[#090909] appearance-none cursor-pointer"
          >
            <option value="">Todos os SDRs</option>
            <option value="__unassigned__">Sem responsável</option>
            {agents.map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>

          <FilterChip label="Hoje" active={filterToday} onClick={() => setFilterToday(v => !v)} />
          <FilterChip
            label="Aguardando resposta"
            active={filterWaiting}
            count={stats.waiting}
            onClick={() => setFilterWaiting(v => !v)}
          />
          <FilterChip
            label="SLA estourado"
            active={filterSLA}
            count={stats.slaBreached}
            danger
            onClick={() => setFilterSLA(v => !v)}
          />
          <FilterChip
            label="Sem responsável"
            active={filterUnassigned}
            count={stats.unassigned}
            onClick={() => setFilterUnassigned(v => !v)}
          />

          {activeFilterCount > 0 && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1 text-[11px] text-[#999] hover:text-[#090909]"
            >
              <X className="h-3 w-3" />
              Limpar
            </button>
          )}
        </div>
      </div>

      {/* ── Kanban ── */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-[#c0c0c0]" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <Users className="h-12 w-12 text-[#e0e0e0]" />
          <p className="text-sm text-[#999]">
            {activeFilterCount > 0
              ? "Nenhuma conversa com os filtros selecionados."
              : "Nenhuma conversa em aberto no momento."}
          </p>
          {activeFilterCount > 0 && (
            <button onClick={clearFilters} className="text-sm text-[#090909] underline">
              Limpar filtros
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-1 gap-4 overflow-x-auto overflow-y-hidden p-6">
          {sortedKeys.map(key => {
            const { assignee, convs } = groups[key];
            const isUnassigned = key === "__unassigned__";
            const supaAgent = isUnassigned
              ? undefined
              : agents.find(a => a.name.toLowerCase() === (assignee?.name ?? "").toLowerCase());
            return (
              <AgentColumn
                key={key}
                assignee={assignee}
                convs={convs}
                supaAgent={supaAgent}
                isUnassigned={isUnassigned}
                onConvClick={handleConvClick}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
