import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn, initialsOf, timeAgo } from "@/lib/utils";
import {
  getChatwootConversations,
  getChatwootMessages,
  sendChatwootMessage,
  sendChatwootAttachment,
  updateChatwootConversationStatus,
  getChatwootTemplates,
  getChatwootAgents,
  assignChatwootConversation,
  startConversationWithTemplate,
} from "@/lib/chatwoot.functions";
import {
  getHubSpotContactByPhone,
  getHubSpotVisibleFields,
  getHubSpotContactNotes,
  createHubSpotNote,
  getHubSpotOwners,
  DEFAULT_HS_FIELDS,
  type HsField,
} from "@/lib/hubspot.functions";
import { supabase } from "@/integrations/supabase/client";
import { Search, Send, Loader2, UserPlus, Play, Pause, ZoomIn, Paperclip, Smile, X, LayoutTemplate, ChevronLeft } from "lucide-react";

const EMOJI_ONLY_RE = /^(\p{Emoji_Presentation}|\p{Extended_Pictographic}|️|‍|\s)+$/u;
function isEmojiOnly(text: string) {
  return EMOJI_ONLY_RE.test(text.trim()) && text.trim().length > 0;
}

function getTplBody(tpl: any): string {
  return tpl.components?.find((c: any) => c.type === "BODY")?.text ?? "";
}

function countTplVars(body: string): number {
  const matches = body.match(/\{\{\d+\}\}/g) ?? [];
  return matches.length === 0 ? 0 : Math.max(...matches.map((m) => parseInt(m.replace(/\D/g, ""))));
}

function formatAudioTime(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

const SPEEDS = [0.5, 1, 1.5, 2] as const;

function AudioPlayer({ src, fromAgent }: { src: string; fromAgent: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (playing) a.pause(); else a.play();
    setPlaying(!playing);
  }

  function cycleSpeed() {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }

  const progress = duration ? (currentTime / duration) * 100 : 0;

  return (
    <div className={cn("flex items-center gap-2.5 rounded-2xl px-3 py-2.5 w-56",
      fromAgent ? "bg-[#1a1a1a]" : "border border-[#e5e5e5] bg-[#f0f0f0]"
    )}>
      <audio
        ref={audioRef}
        src={src}
        onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime ?? 0)}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration ?? 0)}
        onEnded={() => { setPlaying(false); setCurrentTime(0); }}
      />
      <button
        onClick={toggle}
        className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          fromAgent ? "bg-white/10 text-white hover:bg-white/20" : "bg-[#090909] text-white"
        )}
      >
        {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 pl-0.5" />}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="relative h-1 rounded-full bg-white/20 overflow-hidden"
          style={{ background: fromAgent ? "rgba(255,255,255,0.15)" : "#d0d0d0" }}
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${progress}%`, background: fromAgent ? "#00e186" : "#090909" }}
          />
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={0.1}
            value={currentTime}
            onChange={(e) => {
              const t = parseFloat(e.target.value);
              if (audioRef.current) audioRef.current.currentTime = t;
              setCurrentTime(t);
            }}
            className="absolute inset-0 w-full cursor-pointer opacity-0"
          />
        </div>
        <div className={cn("flex justify-between text-[10px]",
          fromAgent ? "text-white/50" : "text-[#999]"
        )}>
          <span>{formatAudioTime(currentTime)}</span>
          <span>{formatAudioTime(duration)}</span>
        </div>
      </div>

      <button
        onClick={cycleSpeed}
        className={cn("shrink-0 w-7 text-center text-[11px] font-bold tabular-nums",
          fromAgent ? "text-white/60 hover:text-white" : "text-[#666] hover:text-[#090909]"
        )}
      >
        {speed}x
      </button>
    </div>
  );
}

const COMMON_EMOJIS = [
  "😀","😃","😄","😊","😍","🥰","😘","😎","🤩","🥳",
  "😂","🤣","😅","😆","😁","🙂","😉","😋","😛","😜",
  "🤔","🤭","🤫","😌","😔","😢","😭","😤","😠","😡",
  "👍","👎","👌","🙏","👏","🤝","✌️","🤞","💪","🙌",
  "❤️","🧡","💛","💚","💙","💜","🤍","💔","💯","🔥",
  "✅","❌","⭐","🎉","🎊","🚀","💡","📌","📞","💬",
  "⏰","📅","📩","🔔","✍️","📝","💼","🇧🇷","🎯","🏆",
] as const;

function parseAgentHeader(text: string): { name: string | null; body: string } {
  const m = text.match(/^\*([^*\n]+)\*\n([\s\S]*)$/);
  return m ? { name: m[1], body: m[2] } : { name: null, body: text };
}

type AttachFile = { file: File; previewUrl: string | null };

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result as string);
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });
}

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
  const [conversations, setConversations] = useState<any[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [hubContact, setHubContact] = useState<any>(null);
  const [hubLoading, setHubLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [sending, setSending] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [myRole, setMyRole] = useState<"admin" | "agent" | null>(null);
  const [myChatwootAgentId, setMyChatwootAgentId] = useState<number | null>(null);
  const [attachFile, setAttachFile] = useState<AttachFile | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [visibleFields, setVisibleFields] = useState<HsField[]>(DEFAULT_HS_FIELDS);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [templatesList, setTemplatesList] = useState<any[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateSearch, setTemplateSearch] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<any | null>(null);
  const [draftIsTemplate, setDraftIsTemplate] = useState(false);
  const [templateVars, setTemplateVars] = useState<string[]>([]);

  // New conversation modal
  const [newConvModal, setNewConvModal] = useState(false);
  const [newConvStep, setNewConvStep] = useState<"contact" | "template" | "vars">("contact");
  const [newConvName, setNewConvName] = useState("");
  const [newConvPhone, setNewConvPhone] = useState("");
  const [newConvTemplate, setNewConvTemplate] = useState<any | null>(null);
  const [newConvVars, setNewConvVars] = useState<string[]>([]);
  const [newConvTplSearch, setNewConvTplSearch] = useState("");
  const [newConvLoading, setNewConvLoading] = useState(false);
  const [newConvError, setNewConvError] = useState("");

  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const templatePickerRef = useRef<HTMLDivElement>(null);

  // Refs para o Realtime ter acesso aos valores atuais sem recriar a subscription
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // Subscription Realtime — recriada somente ao montar/desmontar
  useEffect(() => {
    const channel = supabase
      .channel("chatwoot_events_watch")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chatwoot_events" },
        () => {
          getChatwootConversations({ data: { status: tabRef.current } })
            .then(setConversations)
            .catch(console.error);
          if (activeIdRef.current) {
            getChatwootMessages({ data: { conversationId: activeIdRef.current } })
              .then(setMessages)
              .catch(console.error);
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const { data } = await supabase.from("agents").select("name, role, email").eq("id", u.user.id).maybeSingle();
      if (data?.name) setAgentName(data.name);
      const role = (data?.role ?? "agent") as "admin" | "agent";
      setMyRole(role);
      if (role === "agent") {
        const authEmail = u.user.email ?? (data as any)?.email ?? "";
        try {
          const agents = await getChatwootAgents({ data: {} as Record<string, never> });
          const match = agents.find((a) => a.email === authEmail);
          if (match) setMyChatwootAgentId(match.id);
        } catch (e) {
          console.error(e);
        }
      }
    })();
    getHubSpotVisibleFields()
      .then((fields) => { if (fields?.length) setVisibleFields(fields); })
      .catch(console.error);
  }, []);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
        setShowEmojiPicker(false);
      }
      if (templatePickerRef.current && !templatePickerRef.current.contains(e.target as Node)) {
        setShowTemplatePicker(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const displayedConversations = useMemo(() => {
    if (myRole !== "agent" || myChatwootAgentId === null) return conversations;
    return conversations.filter((c) => c.meta?.assignee?.id === myChatwootAgentId);
  }, [conversations, myRole, myChatwootAgentId]);

  useEffect(() => {
    setLoadingConvs(true);
    setConversations([]);
    setActiveId(null);
    setMessages([]);
    getChatwootConversations({ data: { status: tab } })
      .then((convs) => {
        setConversations(convs);
        if (convs.length > 0) setActiveId(convs[0].id);
      })
      .catch(console.error)
      .finally(() => setLoadingConvs(false));
  }, [tab]);

  useEffect(() => {
    if (!activeId) { setMessages([]); setHubContact(null); return; }
    setLoadingMsgs(true);
    getChatwootMessages({ data: { conversationId: activeId } })
      .then(setMessages)
      .catch(console.error)
      .finally(() => setLoadingMsgs(false));

    const phone = conversations.find((c) => c.id === activeId)?.meta?.sender?.phone_number ?? "";
    setHubContact(null);
    if (phone) {
      setHubLoading(true);
      getHubSpotContactByPhone({ data: { phone, properties: visibleFields.map((f) => f.name) } })
        .then(setHubContact)
        .catch(console.error)
        .finally(() => setHubLoading(false));
    } else {
      setHubLoading(false);
    }
  }, [activeId]);

  const visible = useMemo(
    () =>
      displayedConversations.filter((c) => {
        const name = (c.meta?.sender?.name ?? "").toLowerCase();
        const preview = (c.last_message?.content ?? "").toLowerCase();
        const q = search.toLowerCase();
        return q === "" || name.includes(q) || preview.includes(q);
      }),
    [displayedConversations, search]
  );

  // If role=agent and the selected conversation is not in the filtered list, fix the selection
  useEffect(() => {
    if (myRole !== "agent" || myChatwootAgentId === null) return;
    if (activeId === null) return;
    const isAllowed = displayedConversations.some((c) => c.id === activeId);
    if (!isAllowed) {
      setActiveId(displayedConversations[0]?.id ?? null);
    }
  }, [displayedConversations, myRole, myChatwootAgentId]);

  const active = conversations.find((c) => c.id === activeId) ?? null;

  const displayMessages = useMemo(
    () =>
      messages
        .filter((m) => m.message_type !== 2 && (m.content || m.attachments?.length > 0))
        .map((m) => ({
          id: m.id,
          from: m.message_type === 1 ? ("agent" as const) : ("contact" as const),
          text: (m.content as string) || null,
          attachments: (m.attachments ?? []) as any[],
          at: new Date((m.created_at as number) * 1000).toISOString(),
        })),
    [messages]
  );

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachFile({ file, previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null });
    e.target.value = "";
  }

  async function handleSend() {
    if (!activeId) return;
    const text = draft.trim();
    if (!text && !attachFile) return;

    const prefix = agentName && !draftIsTemplate ? `*${agentName}*\n` : "";
    const content = text ? `${prefix}${text}` : "";

    setSending(true);
    try {
      if (attachFile) {
        const base64 = await readFileAsBase64(attachFile.file);
        await sendChatwootAttachment({
          data: {
            conversationId: activeId,
            content,
            fileName: attachFile.file.name,
            mimeType: attachFile.file.type,
            base64,
          },
        });
        setAttachFile(null);
      } else {
        await sendChatwootMessage({ data: { conversationId: activeId, content } });
      }
      setDraft("");
      setDraftIsTemplate(false);
      const updated = await getChatwootMessages({ data: { conversationId: activeId } });
      setMessages(updated);
    } catch (e) {
      console.error(e);
    } finally {
      setSending(false);
    }
  }

  async function handleStatusChange(status: "open" | "pending" | "resolved") {
    if (!activeId) return;
    try {
      await updateChatwootConversationStatus({ data: { conversationId: activeId, status } });
      const updated = await getChatwootConversations({ data: { status: tab } });
      setConversations(updated);
      setActiveId(updated[0]?.id ?? null);
    } catch (e) {
      console.error(e);
    }
  }

  const filteredTemplates = useMemo(() => {
    const q = templateSearch.toLowerCase();
    return templatesList.filter((t) => {
      if (!q) return true;
      return t.name.toLowerCase().includes(q) || getTplBody(t).toLowerCase().includes(q);
    });
  }, [templatesList, templateSearch]);

  const filteredNewConvTemplates = useMemo(() => {
    const q = newConvTplSearch.toLowerCase();
    return templatesList.filter((t) => {
      if (!q) return true;
      return t.name.toLowerCase().includes(q) || getTplBody(t).toLowerCase().includes(q);
    });
  }, [templatesList, newConvTplSearch]);

  async function ensureTemplatesLoaded() {
    if (templatesList.length > 0 || templatesLoading) return;
    setTemplatesLoading(true);
    try {
      const { templates } = await getChatwootTemplates();
      setTemplatesList(templates.filter((t: any) => t.status === "APPROVED"));
    } catch (e) {
      console.error(e);
    } finally {
      setTemplatesLoading(false);
    }
  }

  function openNewConvModal() {
    setNewConvModal(true);
    setNewConvStep("contact");
    setNewConvName("");
    setNewConvPhone("");
    setNewConvTemplate(null);
    setNewConvVars([]);
    setNewConvTplSearch("");
    setNewConvError("");
  }

  async function handleStartNewConversation() {
    if (!newConvTemplate) return;
    setNewConvLoading(true);
    setNewConvError("");
    try {
      const { data: u } = await supabase.auth.getUser();
      let body = getTplBody(newConvTemplate);
      newConvVars.forEach((v, i) => { body = body.replaceAll(`{{${i + 1}}}`, v); });
      await startConversationWithTemplate({
        data: {
          phone: newConvPhone,
          contactName: newConvName,
          templateName: newConvTemplate.name,
          templateParams: newConvVars,
          language: newConvTemplate.language,
          category: newConvTemplate.category,
          templateBody: body,
          assigneeEmail: u.user?.email,
        },
      });
      setNewConvModal(false);
      const updated = await getChatwootConversations({ data: { status: "open" } });
      setConversations(updated);
      if (tab !== "open") setTab("open");
      if (updated.length > 0) setActiveId(updated[0].id);
    } catch (e: any) {
      setNewConvError(e?.message ?? "Erro ao iniciar conversa");
    } finally {
      setNewConvLoading(false);
    }
  }

  async function openTemplatePicker() {
    setShowTemplatePicker((v) => !v);
    setSelectedTemplate(null);
    setTemplateSearch("");
    if (templatesList.length > 0) return;
    setTemplatesLoading(true);
    try {
      const { templates } = await getChatwootTemplates();
      setTemplatesList(templates.filter((t: any) => t.status === "APPROVED"));
    } catch (e) {
      console.error(e);
    } finally {
      setTemplatesLoading(false);
    }
  }

  function applyTemplate(tpl: any, vars: string[]) {
    let body = getTplBody(tpl);
    vars.forEach((v, i) => { body = body.replaceAll(`{{${i + 1}}}`, v); });
    setDraft(body);
    setDraftIsTemplate(true);
    setShowTemplatePicker(false);
    setSelectedTemplate(null);
    setTemplateVars([]);
    setTemplateSearch("");
  }

  return (
    <div className="flex h-[calc(100vh-52px)]">
      {/* Left: conversation list */}
      <aside className="flex w-[300px] flex-col border-r border-[#e5e5e5]" style={{ background: "#f8f8f8" }}>
        <div className="border-b border-[#e5e5e5] p-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#666]" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar conversas"
                className="h-9 bg-white pl-8"
              />
            </div>
            <button
              onClick={openNewConvModal}
              title="Nova conversa"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#e5e5e5] bg-white text-[#666] transition-colors hover:border-[#090909] hover:text-[#090909]"
            >
              <UserPlus className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex gap-5 border-b border-[#e5e5e5] px-3">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "relative py-3 text-sm transition-colors",
                tab === t.key ? "font-semibold text-[#090909]" : "text-[#666] hover:text-[#090909]"
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
          {loadingConvs ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-[#999]" />
            </div>
          ) : visible.length === 0 ? (
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
                <ContactAvatar
                  name={active.meta?.sender?.name ?? "?"}
                  src={active.meta?.sender?.avatar_url}
                  text="text-sm"
                />
                <div>
                  <div className="text-sm font-semibold text-[#090909]">
                    {active.meta?.sender?.name ?? "Desconhecido"}
                  </div>
                  <div className="text-xs text-[#666]">{active.meta?.sender?.phone_number ?? ""}</div>
                </div>
                <StatusBadge status={active.status} />
              </div>
              <div className="flex items-center gap-2">
                {active.status !== "resolved" && (
                  <Button
                    size="sm"
                    className="bg-[#00e186] text-[#090909] hover:bg-[#00c875]"
                    onClick={() => handleStatusChange("resolved")}
                  >
                    Resolver
                  </Button>
                )}
                {active.status !== "pending" && (
                  <Button size="sm" variant="outline" onClick={() => handleStatusChange("pending")}>
                    Pendente
                  </Button>
                )}
                {active.status !== "open" && (
                  <Button
                    size="sm"
                    className="bg-[#090909] text-white hover:bg-[#090909]/90"
                    onClick={() => handleStatusChange("open")}
                  >
                    Reabrir
                  </Button>
                )}
              </div>
            </header>

            <div className="flex-1 space-y-3 overflow-y-auto px-6 py-5">
              {loadingMsgs ? (
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-[#999]" />
                </div>
              ) : (
                displayMessages.map((m) => {
                  const isAgent = m.from === "agent";
                  const emojiOnly = m.text && isEmojiOnly(m.text) && m.attachments.length === 0;
                  const { name: agentHeader, body: agentBody } =
                    isAgent && m.text ? parseAgentHeader(m.text) : { name: null, body: m.text };

                  if (emojiOnly) {
                    return (
                      <div key={m.id} className={cn("flex", isAgent ? "justify-end" : "justify-start")}>
                        <div>
                          <div className="text-3xl leading-none">{m.text}</div>
                          <div className={cn("mt-1 text-[11px] text-[#666]", isAgent ? "text-right" : "text-left")}>
                            {timeAgo(m.at)} atrás
                          </div>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={m.id} className={cn("flex", isAgent ? "justify-end" : "justify-start")}>
                      <div className="max-w-[70%]">
                        {/* Text bubble */}
                        {m.text && (
                          <div className={cn(
                            "rounded-2xl px-4 py-2.5 text-sm",
                            isAgent ? "bg-[#090909] text-white" : "border border-[#e5e5e5] bg-[#f8f8f8] text-[#090909]"
                          )}>
                            {isAgent && agentHeader && (
                              <div className="mb-0.5 text-[10px] font-semibold text-white/45">{agentHeader}</div>
                            )}
                            <div className="whitespace-pre-wrap">{isAgent ? agentBody : m.text}</div>
                          </div>
                        )}

                        {/* Attachments */}
                        {m.attachments.map((att: any) => {
                          const url = att.data_url ?? att.file_url;

                          if (att.file_type === "audio") {
                            return <AudioPlayer key={att.id} src={url} fromAgent={isAgent} />;
                          }

                          if (att.file_type === "image") {
                            return (
                              <a key={att.id} href={url} target="_blank" rel="noopener noreferrer" className="group block">
                                <div className="relative overflow-hidden rounded-2xl">
                                  <img src={url} alt="" className="max-w-[140px] block" />
                                  <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/25">
                                    <ZoomIn className="h-6 w-6 text-white opacity-0 drop-shadow transition-opacity group-hover:opacity-100" />
                                  </div>
                                </div>
                              </a>
                            );
                          }

                          if (att.file_type === "video") {
                            return (
                              <video key={att.id} controls src={url} className="max-w-[220px] rounded-2xl" />
                            );
                          }

                          return (
                            <a
                              key={att.id}
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={cn(
                                "flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm underline",
                                isAgent ? "bg-[#090909] text-white" : "border border-[#e5e5e5] bg-[#f8f8f8] text-[#090909]"
                              )}
                            >
                              📎 {att.file_name ?? "Arquivo"}
                            </a>
                          );
                        })}

                        <div className={cn("mt-1 text-[11px] text-[#666]", isAgent ? "text-right" : "text-left")}>
                          {timeAgo(m.at)} atrás
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="border-t border-[#e5e5e5] px-6 py-4">
              {/* File preview */}
              {attachFile && (
                <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-[#e5e5e5] bg-[#f8f8f8] px-3 py-2">
                  {attachFile.previewUrl ? (
                    <img src={attachFile.previewUrl} className="h-10 w-10 rounded-lg object-cover" alt="" />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#e5e5e5] text-lg">
                      {attachFile.file.type.startsWith("audio/") ? "🎤" : "📄"}
                    </div>
                  )}
                  <span className="flex-1 truncate text-xs text-[#666]">{attachFile.file.name}</span>
                  <button onClick={() => setAttachFile(null)} className="shrink-0 text-[#999] hover:text-[#090909]">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}

              <div className="flex items-center gap-1.5">
                {/* Attach */}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[#888] hover:bg-[#f0f0f0] hover:text-[#090909]"
                >
                  <Paperclip className="h-[18px] w-[18px]" />
                </button>

                {/* Emoji picker */}
                <div ref={emojiPickerRef} className="relative shrink-0">
                  <button
                    onClick={() => setShowEmojiPicker((v) => !v)}
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-[#888] hover:bg-[#f0f0f0] hover:text-[#090909]"
                  >
                    <Smile className="h-[18px] w-[18px]" />
                  </button>
                  {showEmojiPicker && (
                    <div className="absolute bottom-full left-0 mb-2 grid w-[300px] grid-cols-10 gap-0.5 rounded-xl border border-[#e5e5e5] bg-white p-2 shadow-xl">
                      {COMMON_EMOJIS.map((em) => (
                        <button
                          key={em}
                          onClick={() => { setDraft((d) => d + em); setShowEmojiPicker(false); }}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-lg hover:bg-[#f0f0f0]"
                        >
                          {em}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Template picker */}
                <div ref={templatePickerRef} className="relative shrink-0">
                  <button
                    onClick={openTemplatePicker}
                    title="Usar template"
                    className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-lg hover:bg-[#f0f0f0]",
                      showTemplatePicker ? "bg-[#f0f0f0] text-[#090909]" : "text-[#888] hover:text-[#090909]"
                    )}
                  >
                    <LayoutTemplate className="h-[18px] w-[18px]" />
                  </button>

                  {showTemplatePicker && (
                    <div className="absolute bottom-full left-0 z-30 mb-2 w-[400px] overflow-hidden rounded-xl border border-[#e5e5e5] bg-white shadow-2xl">
                      {selectedTemplate ? (
                        /* Variable fill form */
                        <div className="p-4">
                          <button
                            onClick={() => setSelectedTemplate(null)}
                            className="mb-3 flex items-center gap-1 text-xs text-[#666] hover:text-[#090909]"
                          >
                            <ChevronLeft className="h-3.5 w-3.5" />
                            {selectedTemplate.name}
                          </button>
                          <div className="mb-4 whitespace-pre-wrap rounded-lg bg-[#f8f8f8] p-3 text-xs text-[#090909]">
                            {getTplBody(selectedTemplate)}
                          </div>
                          <div className="space-y-3">
                            {templateVars.map((v, i) => (
                              <div key={i} className="space-y-1">
                                <label className="text-[11px] font-semibold uppercase tracking-wider text-[#666]">
                                  Variável {i + 1}
                                </label>
                                <input
                                  value={v}
                                  onChange={(e) => {
                                    const next = [...templateVars];
                                    next[i] = e.target.value;
                                    setTemplateVars(next);
                                  }}
                                  placeholder={`{{${i + 1}}}`}
                                  className="h-9 w-full rounded-md border border-[#e5e5e5] px-3 text-sm focus:outline-none focus:ring-1 focus:ring-[#090909]"
                                />
                              </div>
                            ))}
                          </div>
                          <div className="mt-4 flex justify-end gap-2">
                            <button
                              onClick={() => setSelectedTemplate(null)}
                              className="rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs hover:bg-[#f0f0f0]"
                            >
                              Voltar
                            </button>
                            <button
                              onClick={() => applyTemplate(selectedTemplate, templateVars)}
                              className="rounded-md bg-[#090909] px-3 py-1.5 text-xs text-white hover:bg-[#090909]/90"
                            >
                              Usar template
                            </button>
                          </div>
                        </div>
                      ) : (
                        /* Template list */
                        <>
                          <div className="border-b border-[#e5e5e5] p-2">
                            <div className="relative">
                              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#999]" />
                              <input
                                autoFocus
                                value={templateSearch}
                                onChange={(e) => setTemplateSearch(e.target.value)}
                                placeholder="Buscar template…"
                                className="w-full rounded-lg border border-[#e5e5e5] py-1.5 pl-8 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-[#090909]"
                              />
                            </div>
                          </div>
                          <div className="max-h-[320px] overflow-y-auto">
                            {templatesLoading ? (
                              <div className="flex items-center justify-center py-10">
                                <Loader2 className="h-4 w-4 animate-spin text-[#999]" />
                              </div>
                            ) : filteredTemplates.length === 0 ? (
                              <p className="py-10 text-center text-sm text-[#999]">
                                {templatesList.length === 0 ? "Nenhum template aprovado." : "Nenhum resultado."}
                              </p>
                            ) : (
                              filteredTemplates.map((t) => {
                                const body = getTplBody(t);
                                const numVars = countTplVars(body);
                                return (
                                  <button
                                    key={t.name + t.language}
                                    onClick={() => {
                                      if (numVars > 0) {
                                        setSelectedTemplate(t);
                                        setTemplateVars(Array(numVars).fill(""));
                                      } else {
                                        applyTemplate(t, []);
                                      }
                                    }}
                                    className="w-full border-b border-[#f0f0f0] px-4 py-3 text-left transition-colors hover:bg-[#f8f8f8] last:border-0"
                                  >
                                    <div className="mb-0.5 flex items-center justify-between gap-2">
                                      <span className="text-xs font-semibold text-[#090909]">{t.name}</span>
                                      <span className="shrink-0 rounded-full bg-[#f0f0f0] px-2 py-0.5 text-[10px] text-[#666]">
                                        {t.language}
                                      </span>
                                    </div>
                                    <p className="line-clamp-2 text-xs text-[#666]">{body}</p>
                                    {numVars > 0 && (
                                      <p className="mt-1 text-[10px] text-[#aaa]">{numVars} variável{numVars > 1 ? "is" : ""}</p>
                                    )}
                                  </button>
                                );
                              })
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <Input
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value); setDraftIsTemplate(false); }}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                  placeholder="Digite uma mensagem…"
                  className="h-11 flex-1"
                />
                <Button
                  size="icon"
                  className="h-11 w-11 shrink-0 bg-[#090909] text-white hover:bg-[#090909]/90"
                  onClick={handleSend}
                  disabled={sending || (!draft.trim() && !attachFile)}
                >
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
                className="hidden"
                onChange={handleFileSelect}
              />
            </div>
          </>
        )}
      </section>

      {/* Right: lead panel */}
      <aside className="w-[320px] overflow-y-auto border-l border-[#e5e5e5] p-4" style={{ background: "#f8f8f8" }}>
        {active ? (
          <LeadPanel
            conv={active}
            messages={messages}
            hubContact={hubContact}
            hubLoading={hubLoading}
            visibleFields={visibleFields}
            onConvUpdate={async () => {
              const updated = await getChatwootConversations({ data: { status: tab } });
              setConversations(updated);
            }}
          />
        ) : null}
      </aside>

      {/* New conversation modal */}
      {newConvModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="relative flex max-h-[85vh] w-[480px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">

            {/* Header */}
            <div className="flex items-center justify-between border-b border-[#e5e5e5] px-6 py-4">
              <div>
                <p className="text-xs text-[#999]">Iniciar conversa via template</p>
                <h2 className="text-base font-semibold text-[#090909]">
                  {newConvStep === "contact" && "Novo contato"}
                  {newConvStep === "template" && "Selecionar template"}
                  {newConvStep === "vars" && (newConvTemplate?.name ?? "Confirmar envio")}
                </h2>
              </div>
              <button
                onClick={() => setNewConvModal(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-[#999] hover:bg-[#f0f0f0] hover:text-[#090909]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Step 1: contact info */}
            {newConvStep === "contact" && (
              <div className="space-y-4 p-6">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-[#666]">Nome</label>
                  <input
                    autoFocus
                    value={newConvName}
                    onChange={(e) => setNewConvName(e.target.value)}
                    placeholder="Nome completo do contato"
                    className="h-10 w-full rounded-lg border border-[#e5e5e5] px-3 text-sm focus:outline-none focus:ring-1 focus:ring-[#090909]"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-[#666]">Telefone</label>
                  <input
                    value={newConvPhone}
                    onChange={(e) => setNewConvPhone(e.target.value)}
                    placeholder="+55 11 99999-9999"
                    type="tel"
                    className="h-10 w-full rounded-lg border border-[#e5e5e5] px-3 text-sm focus:outline-none focus:ring-1 focus:ring-[#090909]"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newConvName.trim() && newConvPhone.trim()) {
                        setNewConvStep("template");
                        ensureTemplatesLoaded();
                      }
                    }}
                  />
                </div>
                <div className="flex justify-end pt-2">
                  <button
                    disabled={!newConvName.trim() || !newConvPhone.trim()}
                    onClick={() => { setNewConvStep("template"); ensureTemplatesLoaded(); }}
                    className="rounded-lg bg-[#090909] px-5 py-2 text-sm font-medium text-white hover:bg-[#090909]/90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Próximo →
                  </button>
                </div>
              </div>
            )}

            {/* Step 2: template picker */}
            {newConvStep === "template" && (
              <div className="flex flex-1 flex-col overflow-hidden">
                <div className="border-b border-[#e5e5e5] p-3">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#999]" />
                    <input
                      autoFocus
                      value={newConvTplSearch}
                      onChange={(e) => setNewConvTplSearch(e.target.value)}
                      placeholder="Buscar template…"
                      className="w-full rounded-lg border border-[#e5e5e5] py-1.5 pl-8 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-[#090909]"
                    />
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                  {templatesLoading ? (
                    <div className="flex items-center justify-center py-16">
                      <Loader2 className="h-4 w-4 animate-spin text-[#999]" />
                    </div>
                  ) : filteredNewConvTemplates.length === 0 ? (
                    <p className="py-16 text-center text-sm text-[#999]">
                      {templatesList.length === 0 ? "Nenhum template aprovado." : "Nenhum resultado."}
                    </p>
                  ) : (
                    filteredNewConvTemplates.map((t) => {
                      const body = getTplBody(t);
                      const numVars = countTplVars(body);
                      return (
                        <button
                          key={t.name + t.language}
                          onClick={() => {
                            setNewConvTemplate(t);
                            setNewConvVars(Array(Math.max(numVars, 0)).fill(""));
                            setNewConvStep("vars");
                          }}
                          className="w-full border-b border-[#f0f0f0] px-5 py-3.5 text-left transition-colors hover:bg-[#f8f8f8] last:border-0"
                        >
                          <div className="mb-0.5 flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-[#090909]">{t.name}</span>
                            <span className="shrink-0 rounded-full bg-[#f0f0f0] px-2 py-0.5 text-[10px] text-[#666]">{t.language}</span>
                          </div>
                          <p className="line-clamp-2 text-xs text-[#666]">{body}</p>
                          {numVars > 0 && (
                            <p className="mt-0.5 text-[10px] text-[#aaa]">{numVars} variável{numVars > 1 ? "is" : ""}</p>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
                <div className="border-t border-[#e5e5e5] px-5 py-3">
                  <button
                    onClick={() => setNewConvStep("contact")}
                    className="flex items-center gap-1 text-xs text-[#666] hover:text-[#090909]"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    Voltar
                  </button>
                </div>
              </div>
            )}

            {/* Step 3: variables + confirm */}
            {newConvStep === "vars" && newConvTemplate && (
              <div className="flex flex-1 flex-col overflow-hidden">
                <div className="flex-1 space-y-4 overflow-y-auto p-5">
                  {/* Contact summary */}
                  <div className="flex gap-8 rounded-lg bg-[#f8f8f8] px-4 py-3 text-sm">
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-[#999]">Nome</div>
                      <div className="text-[#090909]">{newConvName}</div>
                    </div>
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-[#999]">Telefone</div>
                      <div className="text-[#090909]">{newConvPhone}</div>
                    </div>
                  </div>

                  {/* Template body */}
                  <div className="whitespace-pre-wrap rounded-lg border border-[#e5e5e5] bg-[#f8f8f8] px-4 py-3 text-xs text-[#090909]">
                    {getTplBody(newConvTemplate)}
                  </div>

                  {/* Variable fields */}
                  {newConvVars.length > 0 && (
                    <div className="space-y-3">
                      {newConvVars.map((v, i) => (
                        <div key={i} className="space-y-1">
                          <label className="text-[11px] font-semibold uppercase tracking-wider text-[#666]">
                            Variável {i + 1}
                          </label>
                          <input
                            autoFocus={i === 0}
                            value={v}
                            onChange={(e) => {
                              const next = [...newConvVars];
                              next[i] = e.target.value;
                              setNewConvVars(next);
                            }}
                            placeholder={`{{${i + 1}}}`}
                            className="h-9 w-full rounded-md border border-[#e5e5e5] px-3 text-sm focus:outline-none focus:ring-1 focus:ring-[#090909]"
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {newConvError && (
                    <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{newConvError}</p>
                  )}
                </div>

                <div className="flex items-center justify-between border-t border-[#e5e5e5] px-5 py-3">
                  <button
                    onClick={() => { setNewConvStep("template"); setNewConvTemplate(null); }}
                    className="flex items-center gap-1 text-xs text-[#666] hover:text-[#090909]"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    Voltar
                  </button>
                  <button
                    disabled={newConvLoading || newConvVars.some((v) => !v.trim())}
                    onClick={handleStartNewConversation}
                    className="flex items-center gap-2 rounded-lg bg-[#090909] px-5 py-2 text-sm font-medium text-white hover:bg-[#090909]/90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {newConvLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    Iniciar conversa
                  </button>
                </div>
              </div>
            )}

          </div>
        </div>
      )}
    </div>
  );
}

function ContactAvatar({
  name,
  src,
  size = "h-9 w-9",
  text = "text-xs",
  onClick,
}: {
  name: string;
  src?: string | null;
  size?: string;
  text?: string;
  onClick?: () => void;
}) {
  const [err, setErr] = useState(false);
  const showImg = !!src && !err;
  return (
    <div
      onClick={onClick}
      className={cn(
        "shrink-0 overflow-hidden rounded-full flex items-center justify-center font-semibold",
        size,
        text,
        onClick && showImg ? "cursor-pointer ring-2 ring-transparent hover:ring-[#00e186] transition-all" : ""
      )}
      style={!showImg ? { background: "#00e186", color: "#090909" } : undefined}
    >
      {showImg ? (
        <img src={src} alt={name} className="h-full w-full object-cover" onError={() => setErr(true)} />
      ) : (
        initialsOf(name)
      )}
    </div>
  );
}

function ConversationRow({ conv, active, onClick }: { conv: any; active: boolean; onClick: () => void }) {
  const name = conv.meta?.sender?.name ?? "Desconhecido";
  const preview = conv.last_message?.content ?? "";
  const updatedAt = conv.last_activity_at
    ? new Date(conv.last_activity_at * 1000).toISOString()
    : new Date().toISOString();
  const unread = (conv.unread_count ?? 0) > 0;

  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-3 border-b border-[#e5e5e5] px-3 py-3 text-left transition-colors",
        active ? "bg-white" : "hover:bg-white/60"
      )}
    >
      <ContactAvatar name={name} src={conv.meta?.sender?.avatar_url} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold text-[#090909]">{name}</span>
          <span className="shrink-0 text-[11px] text-[#666]">{timeAgo(updatedAt)}</span>
        </div>
        <p className="mt-0.5 truncate text-xs text-[#666]">{preview}</p>
      </div>
      {unread && (
        <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: "#00e186" }} />
      )}
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; bg: string; fg: string }> = {
    open: { label: "Aberta", bg: "#e6fff6", fg: "#00a86b" },
    pending: { label: "Pendente", bg: "#fff4dc", fg: "#b45309" },
    resolved: { label: "Resolvida", bg: "#f0f0f0", fg: "#666" },
  };
  const s = map[status] ?? map.open;
  return (
    <span
      className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
      style={{ background: s.bg, color: s.fg }}
    >
      {s.label}
    </span>
  );
}

function LeadPanel({
  conv, messages, hubContact, hubLoading, visibleFields, onConvUpdate,
}: {
  conv: any;
  messages: any[];
  hubContact: any | null;
  hubLoading: boolean;
  visibleFields: HsField[];
  onConvUpdate: () => Promise<void>;
}) {
  const name = conv.meta?.sender?.name ?? "Desconhecido";
  const phone = conv.meta?.sender?.phone_number ?? "";
  const email = conv.meta?.sender?.email;
  const avatarUrl = conv.meta?.sender?.avatar_url as string | null | undefined;

  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [notes, setNotes] = useState<any[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [newNote, setNewNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  // HubSpot owners map: id → display name
  const [ownersMap, setOwnersMap] = useState<Record<string, string>>({});

  useEffect(() => {
    const needsOwner = visibleFields.some((f) => f.name === "hubspot_owner_id");
    if (!needsOwner) return;
    getHubSpotOwners()
      .then((owners) => {
        const map: Record<string, string> = {};
        for (const o of owners) {
          const fullName = [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email;
          map[String(o.id)] = fullName;
        }
        setOwnersMap(map);
      })
      .catch(console.error);
  }, []);

  // Assignment
  const [chatwootAgents, setChatwootAgents] = useState<{ id: number; name: string; email: string; availability_status: string }[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [assigning, setAssigning] = useState(false);

  useEffect(() => {
    getChatwootAgents({ data: {} as Record<string, never> })
      .then(setChatwootAgents)
      .catch(console.error);
  }, []);

  // Pre-select current assignee
  useEffect(() => {
    const assigneeId = conv.meta?.assignee?.id;
    setSelectedAgentId(assigneeId ? String(assigneeId) : "");
  }, [conv.meta?.assignee?.id]);

  async function handleAssign() {
    const agentId = selectedAgentId ? Number(selectedAgentId) : null;
    setAssigning(true);
    try {
      await assignChatwootConversation({ data: { conversationId: conv.id, assigneeId: agentId } });
      await onConvUpdate();
    } catch (e) {
      console.error(e);
    } finally {
      setAssigning(false);
    }
  }

  // Activity log: message_type=2 (Chatwoot assignment/status events)
  const activityLog = useMemo(
    () => messages
      .filter((m) => m.message_type === 2 && m.content)
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0)),
    [messages]
  );

  useEffect(() => {
    if (!hubContact?.id) { setNotes([]); return; }
    setNotesLoading(true);
    getHubSpotContactNotes({ data: { contactId: String(hubContact.id) } })
      .then(setNotes)
      .catch(console.error)
      .finally(() => setNotesLoading(false));
  }, [hubContact?.id]);

  async function saveNote() {
    if (!newNote.trim() || !hubContact?.id) return;
    setSavingNote(true);
    try {
      await createHubSpotNote({ data: { contactId: String(hubContact.id), body: newNote.trim() } });
      setNewNote("");
      const updated = await getHubSpotContactNotes({ data: { contactId: String(hubContact.id) } });
      setNotes(updated);
    } catch (e) {
      console.error(e);
    } finally {
      setSavingNote(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-[10px] border border-[#e5e5e5] bg-white p-4">
        <div className="label-uppercase mb-3">Contato</div>
        <div className="mb-3 flex items-center gap-3">
          <ContactAvatar
            name={name}
            src={avatarUrl}
            size="h-14 w-14"
            text="text-xl"
            onClick={avatarUrl ? () => setLightboxOpen(true) : undefined}
          />
          <div className="min-w-0">
            <div className="truncate font-semibold text-[#090909]">{name}</div>
            {phone && <div className="truncate text-xs text-[#666]">{phone}</div>}
            {email && <div className="truncate text-xs text-[#666]">{email}</div>}
          </div>
        </div>
      </div>

      {/* Avatar lightbox */}
      {lightboxOpen && avatarUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm"
          onClick={() => setLightboxOpen(false)}
        >
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <img
              src={avatarUrl}
              alt={name}
              className="max-h-[80vh] max-w-[80vw] rounded-2xl object-contain shadow-2xl"
            />
            <button
              onClick={() => setLightboxOpen(false)}
              className="absolute -right-3 -top-3 flex h-8 w-8 items-center justify-center rounded-full bg-white text-[#090909] shadow-lg hover:bg-[#f0f0f0]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {hubLoading ? (
        <div className="rounded-[10px] border border-[#e5e5e5] bg-white p-4">
          <div className="flex items-center gap-2 text-xs text-[#999]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Buscando no HubSpot…
          </div>
        </div>
      ) : hubContact ? (
        <div className="rounded-[10px] border border-[#e5e5e5] bg-white p-4">
          <div className="label-uppercase mb-3">HubSpot CRM</div>
          <div className="space-y-2.5 text-sm">
            {visibleFields.map((f) => {
              const value = hubContact.properties?.[f.name];
              if (!value) return null;
              const display =
                f.name === "hubspot_owner_id"
                  ? (ownersMap[String(value)] ?? String(value))
                  : formatHsValue(String(value));
              return <Field key={f.name} label={f.label} value={display} />;
            })}
          </div>
        </div>
      ) : null}

      {hubContact && (
        <div className="rounded-[10px] border border-[#e5e5e5] bg-white p-4">
          <div className="label-uppercase mb-3">Observações</div>

          {notesLoading ? (
            <div className="flex items-center gap-2 text-xs text-[#999]">
              <Loader2 className="h-3 w-3 animate-spin" />
              Carregando…
            </div>
          ) : notes.length > 0 ? (
            <div className="mb-3 max-h-[220px] space-y-2 overflow-y-auto pr-0.5">
              {notes.map((n) => (
                <div key={n.id} className="rounded-lg bg-[#f8f8f8] px-3 py-2">
                  <div className="mb-1 text-[10px] text-[#999]">
                    {formatHsValue(n.properties.hs_timestamp)}
                  </div>
                  <div className="whitespace-pre-wrap text-xs text-[#090909]">
                    {n.properties.hs_note_body}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mb-3 text-xs text-[#999]">Nenhuma observação ainda.</p>
          )}

          <textarea
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && e.metaKey) saveNote(); }}
            placeholder="Nova observação… (⌘Enter para salvar)"
            rows={3}
            className="w-full resize-none rounded-lg border border-[#e5e5e5] px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-[#090909]"
          />
          <Button
            size="sm"
            className="mt-2 w-full bg-[#090909] text-white hover:bg-[#090909]/90"
            onClick={saveNote}
            disabled={savingNote || !newNote.trim()}
          >
            {savingNote ? <Loader2 className="h-3 w-3 animate-spin" /> : "Salvar observação"}
          </Button>
        </div>
      )}

      {/* Atribuição */}
      <div className="rounded-[10px] border border-[#e5e5e5] bg-white p-4">
        <div className="label-uppercase mb-3">Atribuição</div>

        {/* Atual */}
        <div className="mb-3 flex items-center gap-2">
          {conv.meta?.assignee ? (
            <>
              <div
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
                style={{ background: "#00e186", color: "#090909" }}
              >
                {initialsOf(conv.meta.assignee.name)}
              </div>
              <span className="text-sm text-[#090909]">{conv.meta.assignee.name}</span>
            </>
          ) : (
            <span className="text-sm text-[#999]">Não atribuído</span>
          )}
        </div>

        {/* Dropdown + botão */}
        <div className="flex gap-2">
          <select
            value={selectedAgentId}
            onChange={(e) => setSelectedAgentId(e.target.value)}
            className="flex-1 rounded-md border border-[#e5e5e5] px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-[#090909]"
          >
            <option value="">Sem atribuição</option>
            {chatwootAgents.map((a) => (
              <option key={a.id} value={String(a.id)}>{a.name}</option>
            ))}
          </select>
          <Button
            size="sm"
            className="shrink-0 bg-[#090909] text-white hover:bg-[#090909]/90"
            onClick={handleAssign}
            disabled={assigning}
          >
            {assigning ? <Loader2 className="h-3 w-3 animate-spin" /> : "Atribuir"}
          </Button>
        </div>

        {/* Histórico de atividades */}
        {activityLog.length > 0 && (
          <div className="mt-3 space-y-1.5 border-t border-[#f0f0f0] pt-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[#999]">Histórico</p>
            {activityLog.map((m) => (
              <div key={m.id} className="text-[11px] text-[#999]">
                <span className="text-[#ccc]">{timeAgo(new Date((m.created_at as number) * 1000).toISOString())} atrás</span>
                {" — "}
                <span>{m.content}</span>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}

const dtFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit", month: "2-digit", year: "numeric",
  hour: "2-digit", minute: "2-digit",
});
const dFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit", month: "2-digit", year: "numeric",
});

function formatHsValue(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) {
    try { return dtFmt.format(new Date(raw)); } catch {}
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    try { return dFmt.format(new Date(raw + "T12:00:00Z")); } catch {}
  }
  if (/^\d{10,13}$/.test(raw)) {
    const n = Number(raw);
    try { return dFmt.format(new Date(raw.length === 13 ? n : n * 1000)); } catch {}
  }
  return raw;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label-uppercase mb-0.5">{label}</div>
      <div className="font-medium text-[#090909]">{value}</div>
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
