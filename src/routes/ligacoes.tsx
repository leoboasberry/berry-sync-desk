import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { formatDuration, initialsOf } from "@/lib/utils";
import { ExternalLink, Filter, PhoneCall, PhoneMissed, PlayCircle } from "lucide-react";

export const Route = createFileRoute("/ligacoes")({
  head: () => ({ meta: [{ title: "Ligações — Berry" }] }),
  component: () => (
    <AppShell>
      <LigacoesPage />
    </AppShell>
  ),
});

type CallLog = {
  id: string;
  contact_name: string | null;
  contact_phone: string | null;
  agent_id: string | null;
  hubspot_contact_id: string | null;
  duration_seconds: number | null;
  status: string | null;
  recording_url: string | null;
  transcript: string | null;
  ai_summary: string | null;
  created_at: string;
};

function LigacoesPage() {
  const [calls, setCalls] = useState<CallLog[] | null>(null);
  const [selected, setSelected] = useState<CallLog | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("call_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);
      setCalls((data as CallLog[]) ?? []);
    })();

    const channel = supabase
      .channel("call_logs_live")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "call_logs" }, (payload) => {
        setCalls((prev) => [payload.new as CallLog, ...(prev ?? [])]);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-[22px] font-bold text-[#090909]">Ligações</h1>
        <Button variant="outline" size="sm">
          <Filter className="mr-2 h-3.5 w-3.5" />
          Filtros
        </Button>
      </div>

      <div className="overflow-hidden rounded-[10px] border border-[#e5e5e5] bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-[#e5e5e5] bg-[#f8f8f8]">
            <tr className="text-left">
              <Th>Data/hora</Th>
              <Th>Contato</Th>
              <Th>Agente</Th>
              <Th>Duração</Th>
              <Th>Status</Th>
              <Th>Resumo AI</Th>
            </tr>
          </thead>
          <tbody>
            {calls === null ? (
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-b border-[#e5e5e5] last:border-0">
                  {Array.from({ length: 6 }).map((_, j) => (
                    <td key={j} className="px-4 py-4">
                      <Skeleton className="h-3 w-full" />
                    </td>
                  ))}
                </tr>
              ))
            ) : calls.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-16 text-center text-[#666]">
                  <PhoneCall className="mx-auto mb-3 h-10 w-10 text-[#c0c0c0]" />
                  Nenhuma ligação registrada. Quando o CloudTalk enviar webhooks, elas
                  aparecerão aqui.
                </td>
              </tr>
            ) : (
              calls.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => setSelected(c)}
                  className="cursor-pointer border-b border-[#e5e5e5] last:border-0 hover:bg-[#fafafa]"
                >
                  <td className="px-4 py-3 text-[#090909]">
                    {new Date(c.created_at).toLocaleString("pt-BR")}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div
                        className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold"
                        style={{ background: "#00e186", color: "#090909" }}
                      >
                        {initialsOf(c.contact_name ?? "?")}
                      </div>
                      <div>
                        <div className="font-medium text-[#090909]">
                          {c.contact_name ?? "Desconhecido"}
                        </div>
                        <div className="text-xs text-[#666]">{c.contact_phone}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[#666]">—</td>
                  <td className="px-4 py-3 text-[#090909]">{formatDuration(c.duration_seconds)}</td>
                  <td className="px-4 py-3">
                    <CallStatusBadge status={c.status} />
                  </td>
                  <td className="max-w-[260px] px-4 py-3">
                    <div className="truncate text-[#666]">
                      {c.ai_summary ?? "Aguardando processamento…"}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-[400px] sm:max-w-[400px]">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{selected.contact_name ?? "Ligação"}</SheetTitle>
              </SheetHeader>
              <div className="mt-6 space-y-4">
                <div className="flex items-center gap-3 text-sm">
                  <div
                    className="flex h-10 w-10 items-center justify-center rounded-full font-semibold"
                    style={{ background: "#00e186", color: "#090909" }}
                  >
                    {initialsOf(selected.contact_name ?? "?")}
                  </div>
                  <div>
                    <div className="font-semibold text-[#090909]">
                      {selected.contact_name}
                    </div>
                    <div className="text-xs text-[#666]">{selected.contact_phone}</div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <Stat label="Duração" value={formatDuration(selected.duration_seconds)} />
                  <Stat label="Status" value={selected.status ?? "—"} />
                </div>

                <div>
                  <div className="label-uppercase mb-2">Resumo AI</div>
                  <div className="rounded-[10px] border border-[#e5e5e5] bg-[#f8f8f8] p-4 text-sm leading-relaxed text-[#090909]">
                    {selected.ai_summary ?? "Resumo ainda não gerado."}
                  </div>
                </div>

                {selected.recording_url && (
                  <Button variant="outline" className="w-full" asChild>
                    <a href={selected.recording_url} target="_blank" rel="noreferrer">
                      <PlayCircle className="mr-2 h-4 w-4" />
                      Ver gravação
                    </a>
                  </Button>
                )}

                <Button variant="outline" className="w-full">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Ver no HubSpot
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-[#666]">
      {children}
    </th>
  );
}

function CallStatusBadge({ status }: { status: string | null }) {
  if (status === "missed") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
        style={{ background: "#ffe8d6", color: "#c2410c" }}
      >
        <PhoneMissed className="h-3 w-3" /> Perdida
      </span>
    );
  }
  return (
    <span
      className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
      style={{ background: "#e6fff6", color: "#00a86b" }}
    >
      Completada
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] border border-[#e5e5e5] bg-white p-3">
      <div className="label-uppercase mb-1">{label}</div>
      <div className="font-medium text-[#090909]">{value}</div>
    </div>
  );
}
