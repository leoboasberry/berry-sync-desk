import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn, initialsOf, timeAgo } from "@/lib/utils";
import {
  getChatwootConversations,
  getChatwootMessages,
  getContactHistory,
  getContactHistoryById,
  backfillContactHistory,
  deleteHistoryMessage,
  sendChatwootMessage,
  sendChatwootTemplate,
  sendChatwootAttachment,
  updateChatwootConversationStatus,
  getChatwootTemplates,
  getChatwootAgents,
  assignChatwootConversation,
  startConversationWithTemplate,
  retryChatwootMessage,
  markConversationRead,
  markConversationUnread,
  getChatwootConversationById,
} from "@/lib/chatwoot.functions";
import { debugHubSpotContact } from "@/lib/hubspot.functions";
import {
  getHubSpotContactByPhone,
  getHubSpotVisibleFields,
  getHubSpotContactNotes,
  createHubSpotNote,
  getHubSpotOwners,
  upsertContactOwnerCache,
  getContactOwnersBatch,
  DEFAULT_HS_FIELDS,
  type HsField,
} from "@/lib/hubspot.functions";
import { supabase } from "@/integrations/supabase/client";
import { Search, Send, Loader2, UserPlus, Play, Pause, ZoomIn, Paperclip, Smile, X, LayoutTemplate, ChevronLeft, Mic, Square, Volume2, VolumeX, Check, CheckCheck, AlertCircle, RotateCcw, Link, Trash2 } from "lucide-react";

function sendBrowserNotification(title: string, body: string) {
  if (!("Notification" in window)) return;
  if (document.hasFocus()) return; // only notify when app is in background
  if (Notification.permission === "granted") {
    new Notification(title, { body, icon: "/favicon.ico" });
  } else if (Notification.permission === "default") {
    Notification.requestPermission().then((perm) => {
      if (perm === "granted") new Notification(title, { body, icon: "/favicon.ico" });
    });
  }
}

function playNotificationSound() {
  const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx() as AudioContext;
  const t = ctx.currentTime;

  // Two-tone chime: A5 → C#6
  [{ freq: 880, start: t, end: t + 0.18 }, { freq: 1108, start: t + 0.12, end: t + 0.32 }].forEach(({ freq, start, end }) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.25, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, end);
    osc.start(start);
    osc.stop(end);
  });
  setTimeout(() => ctx.close(), 500);
}

function fmtBRT(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const isToday = d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) === today.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  if (isToday) {
    return d.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// Client-side phone normalization (mirrors server-side in chatwoot.functions.ts)
function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const d = raw.replace(/\D/g, "");
  if (d.length === 13 && d.startsWith("55")) return d;
  if (d.length === 12 && d.startsWith("55")) return d.slice(0, 4) + "9" + d.slice(4);
  if (d.length === 11) return "55" + d;
  if (d.length === 10) return "55" + d.slice(0, 2) + "9" + d.slice(2);
  return d;
}

// Pick the "best" name: prefer the longer/more complete one
function bestName(a: string, b: string): string {
  const clean = (s: string) => s.trim().replace(/\s+/g, " ");
  const ca = clean(a); const cb = clean(b);
  if (!ca) return cb; if (!cb) return ca;
  // Prefer names with spaces (full name) over single word
  const aHasSpace = ca.includes(" "); const bHasSpace = cb.includes(" ");
  if (aHasSpace && !bHasSpace) return ca;
  if (bHasSpace && !aHasSpace) return cb;
  // Otherwise prefer longer
  return ca.length >= cb.length ? ca : cb;
}

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
      fromAgent ? "bg-[#1a1a1a]" : "border border-[#e5e5e5] dark:border-[#2a2a2a] bg-[#f0f0f0] dark:bg-[#252525]"
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
          fromAgent ? "text-white/50" : "text-[#999] dark:text-[#686868]"
        )}>
          <span>{formatAudioTime(currentTime)}</span>
          <span>{formatAudioTime(duration)}</span>
        </div>
      </div>

      <button
        onClick={cycleSpeed}
        className={cn("shrink-0 w-7 text-center text-[11px] font-bold tabular-nums",
          fromAgent ? "text-white/60 hover:text-white" : "text-[#666] dark:text-[#909090] hover:text-[#090909] dark:hover:text-[#e8e8e8]"
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

// WhatsApp delivery status icons (shown only on outgoing agent messages)
function MessageStatus({
  status,
  errorCode,
  errorMessage,
}: {
  status?: number;
  errorCode?: string;
  errorMessage?: string;
}) {
  if (errorCode || status === 3) {
    const tip = errorMessage
      ? `Erro ${errorCode ?? ""}: ${errorMessage}`
      : errorCode
      ? `Erro ${errorCode}: mensagem não entregue`
      : "Falha no envio";
    return (
      <span title={tip} className="inline-flex items-center gap-0.5 text-red-400">
        <AlertCircle className="h-3 w-3" />
        <span className="text-[10px]">{errorCode ?? "erro"}</span>
      </span>
    );
  }
  if (status === 2) {
    return <span title="Lida"><CheckCheck className="inline h-3.5 w-3.5 text-blue-400" /></span>;
  }
  if (status === 1) {
    return <span title="Entregue"><CheckCheck className="inline h-3.5 w-3.5 text-white/50" /></span>;
  }
  if (status === 0) {
    return <span title="Enviada"><Check className="inline h-3.5 w-3.5 text-white/50" /></span>;
  }
  return null;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result as string);
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });
}

type AtendimentoSearch = {
  conversationId?: number;
  status?: "open" | "pending" | "resolved";
};

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): AtendimentoSearch => ({
    conversationId: search.conversationId ? Number(search.conversationId) : undefined,
    status: (search.status as AtendimentoSearch["status"]) ?? undefined,
  }),
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
  const routeSearch = Route.useSearch();
  const navigate = Route.useNavigate();
  const pendingConversationIdRef = useRef<number | null>(routeSearch.conversationId ?? null);
  const [tab, setTab] = useState<Tab>(routeSearch.status ?? "open");
  const [search, setSearch] = useState("");
  const [conversations, setConversations] = useState<any[]>([]);
  const [searchAllConvs, setSearchAllConvs] = useState<any[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [activePhone, setActivePhone] = useState<string | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [historyMessages, setHistoryMessages] = useState<any[]>([]);
  const [backfilling, setBackfilling] = useState(false);
  const [hubContact, setHubContact] = useState<any>(null);
  const [hubLoading, setHubLoading] = useState(false);
  const [hubChangedFields, setHubChangedFields] = useState<Set<string>>(new Set());
  const prevHubPropsRef = useRef<Record<string, any>>({});
  const [draft, setDraft] = useState("");
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [sending, setSending] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [agentEmail, setAgentEmail] = useState("");
  const [myHubspotOwnerId, setMyHubspotOwnerId] = useState<string | null>(null);
  const [ownerCache, setOwnerCache] = useState<Record<string, string | null>>({}); // phone → hubspot_owner_id | null
  const [ownerCacheReady, setOwnerCacheReady] = useState(false);
  const [myRole, setMyRole] = useState<"admin" | "agent" | null>(null);
  const [myChatwootAgentId, setMyChatwootAgentId] = useState<number | null>(null);
  const [attachFile, setAttachFile] = useState<AttachFile | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [visibleFields, setVisibleFields] = useState<HsField[]>(DEFAULT_HS_FIELDS);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [templatesList, setTemplatesList] = useState<any[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateSearch, setTemplateSearch] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<any | null>(null);
  const [draftIsTemplate, setDraftIsTemplate] = useState(false);
  const [draftTemplateInfo, setDraftTemplateInfo] = useState<{ tpl: any; params: string[] } | null>(null);
  const [templateVars, setTemplateVars] = useState<string[]>([]);

  // In-app push notifications
  const [pushNotifs, setPushNotifs] = useState<Array<{ id: number; sender: string; preview: string; convId: number | null }>>([]);
  const pushNotifIdRef = useRef(0);

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
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingCancelledRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [soundEnabled, setSoundEnabled] = useState(() =>
    localStorage.getItem("berry_sound") !== "off"
  );
  const [respondedConvIds, setRespondedConvIds] = useState<Set<number>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("berry_responded") ?? "[]")); } catch { return new Set(); }
  });
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const lastSentRef = useRef<number>(0);
  const prevMessagesRef = useRef<any[]>([]);

  // Refs para o Realtime ter acesso aos valores atuais sem recriar a subscription
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const conversationsRef = useRef<any[]>([]);
  conversationsRef.current = conversations;
  // Debounce timer for realtime-triggered sidebar refresh
  const realtimeSidebarDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Subscription Realtime — recriada somente ao montar/desmontar
  useEffect(() => {
    const channel = supabase
      .channel("chatwoot_events_watch")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chatwoot_events" },
        (event) => {
          const ev = event.new as any;
          const isMessageCreated = ev?.event_type === "message_created";
          const isIncoming = isMessageCreated && ev?.message_type === "incoming";
          const evConvId: number | null = ev?.conversation_id ?? null;

          // Nova mensagem incoming limpa o "marcado como respondido"
          if (isIncoming && evConvId) {
            setRespondedConvIds((prev) => {
              if (!prev.has(evConvId)) return prev;
              const next = new Set(prev); next.delete(evConvId);
              localStorage.setItem("berry_responded", JSON.stringify([...next]));
              return next;
            });
          }

          // Optimistic update: update sidebar instantly from event data (no API round-trip)
          if (isMessageCreated && evConvId) {
            const now = Math.floor(Date.now() / 1000);
            const optimisticLastMsg = ev.content
              ? { content: ev.content, message_type: ev.message_type === "incoming" ? 0 : 1, created_at: now }
              : undefined;
            setConversations((prev) => {
              const updated = prev.map((c) => {
                if (c.id !== evConvId) return c;
                return {
                  ...c,
                  last_activity_at: now,
                  unread_count: isIncoming && evConvId !== activeIdRef.current
                    ? (c.unread_count ?? 0) + 1
                    : c.unread_count,
                  ...(optimisticLastMsg ? { last_message: optimisticLastMsg } : {}),
                };
              });
              return updated.sort((a, b) => (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0));
            });
          }

          // Debounced background refresh — batches rapid events into one Chatwoot request
          if (realtimeSidebarDebounceRef.current) clearTimeout(realtimeSidebarDebounceRef.current);
          realtimeSidebarDebounceRef.current = setTimeout(() => {
            getChatwootConversations({ data: { status: tabRef.current } })
              .then((convs) => setConversations(convs.map((c: any) => ({
                ...c,
                last_message: c.last_non_activity_message ?? c.last_message ?? null,
              }))))
              .catch(console.error);
          }, 2_000);

          // Notify for incoming messages in non-active conversations — always, regardless of focus
          if (isMessageCreated && isIncoming && evConvId !== activeIdRef.current) {
            if (soundEnabledRef.current && Date.now() - lastSentRef.current >= 3000) {
              playNotificationSound();
            }
            const conv = evConvId ? conversationsRef.current.find((c) => c.id === evConvId) : null;
            const senderName = conv?.meta?.sender?.name ?? "Novo contato";
            sendBrowserNotification(senderName, ev.content ?? "Nova mensagem");
            const id = ++pushNotifIdRef.current;
            setPushNotifs((prev) => [...prev, { id, sender: senderName, preview: ev.content ?? "", convId: evConvId }]);
          }

          if (activeIdRef.current) {
            getChatwootMessages({ data: { conversationId: activeIdRef.current } })
              .then((result) => {
                const newMsgs = result.msgs;
                if (isMessageCreated && soundEnabledRef.current) {
                  const prevIds = new Set(prevMessagesRef.current.map((m: any) => m.id));
                  const recentlySentOwn = Date.now() - lastSentRef.current < 3000;
                  const hasNewIncoming = newMsgs.some(
                    (m: any) => !prevIds.has(m.id) && m.message_type === 0
                  );
                  // Active conversation: only show visual notif when app is in background
                  if (hasNewIncoming && !recentlySentOwn && (document.hidden || document.visibilityState === "hidden")) {
                    const conv = evConvId ? conversationsRef.current.find((c) => c.id === evConvId) : null;
                    const senderName = conv?.meta?.sender?.name ?? "Nova mensagem";
                    sendBrowserNotification(senderName, ev.content ?? "");
                    const id = ++pushNotifIdRef.current;
                    setPushNotifs((prev) => [...prev, { id, sender: senderName, preview: ev.content ?? "", convId: evConvId }]);
                  }
                }
                prevMessagesRef.current = newMsgs;
                setMessages(newMsgs);
                setConversations((prev) => prev.map((c) =>
                  c.id === activeIdRef.current ? { ...c, can_reply: result.can_reply } : c
                ));
              })
              .catch(console.error);
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  // Fallback polling for sidebar — refreshes conversations list every 8s
  // Ensures sidebar stays in sync even when realtime events are delayed/missed
  useEffect(() => {
    const sidebarPoll = setInterval(() => {
      getChatwootConversations({ data: { status: tabRef.current } })
        .then((convs) => {
          const normalized = convs.map((c: any) => ({
            ...c,
            last_message: c.last_non_activity_message ?? c.last_message ?? null,
          }));
          setConversations(normalized);
          try {
            localStorage.setItem(`berry_convs_${tabRef.current}`, JSON.stringify({ convs: normalized, ts: Date.now() }));
          } catch {}
        })
        .catch(() => {});
    }, 30_000);
    return () => clearInterval(sidebarPoll);
  }, []);

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const { data } = await supabase.from("agents").select("name, role, email, hubspot_owner_id").eq("id", u.user.id).maybeSingle();
      if (data?.name) setAgentName(data.name);
      const email = u.user.email ?? (data as any)?.email ?? "";
      if (email) setAgentEmail(email);
      if ((data as any)?.hubspot_owner_id) setMyHubspotOwnerId((data as any).hubspot_owner_id);
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

  // When search is active, search locally from localStorage cache (instant)
  // then refresh from Chatwoot in background if cache is stale (>2min)
  useEffect(() => {
    if (!search.trim()) { setSearchAllConvs([]); return; }

    // Immediate: merge all cached tabs from localStorage
    const loadFromCache = () => {
      const byId = new Map<number, any>();
      for (const status of ["open", "pending", "resolved"] as const) {
        try {
          const raw = localStorage.getItem(`berry_convs_${status}`);
          if (!raw) continue;
          const { convs } = JSON.parse(raw);
          if (Array.isArray(convs)) {
            for (const c of convs) byId.set(c.id, c);
          }
        } catch {}
      }
      return Array.from(byId.values());
    };

    const cached = loadFromCache();
    if (cached.length) {
      setSearchAllConvs(cached);
      setSearchLoading(false);
    } else {
      setSearchLoading(true);
    }

    // Background refresh from Chatwoot if cache is old or missing
    const cacheAge = (() => {
      try {
        const raw = localStorage.getItem("berry_convs_open");
        if (!raw) return Infinity;
        return Date.now() - JSON.parse(raw).ts;
      } catch { return Infinity; }
    })();

    if (cacheAge > 2 * 60_000) {
      Promise.all([
        getChatwootConversations({ data: { status: "open" } }),
        getChatwootConversations({ data: { status: "pending" } }),
        getChatwootConversations({ data: { status: "resolved" } }),
      ])
        .then(([open, pending, resolved]) => {
          const byId = new Map<number, any>();
          for (const c of [...open, ...pending, ...resolved]) {
            byId.set(c.id, { ...c, last_message: c.last_non_activity_message ?? c.last_message ?? null });
          }
          setSearchAllConvs(Array.from(byId.values()));
        })
        .catch(console.error)
        .finally(() => setSearchLoading(false));
    }
  }, [search]);

  const displayedConversations = useMemo(() => {
    let result = conversations;
    // Agents see only their own + unassigned Chatwoot conversations
    if (myRole === "agent" && myChatwootAgentId !== null) {
      result = result.filter(
        (c) => !c.meta?.assignee?.id || c.meta?.assignee?.id === myChatwootAgentId
      );
    }
    // HubSpot owner filter: hold until cache is ready to avoid flash of wrong conversations
    if (myHubspotOwnerId) {
      if (!ownerCacheReady) return [];
      result = result.filter((c) => {
        const phone = normalizePhone(c.meta?.sender?.phone_number);
        if (!phone || !(phone in ownerCache)) return true; // unknown — show to all
        const owner = ownerCache[phone];
        return owner === null || owner === myHubspotOwnerId;
      });
    }
    return result;
  }, [conversations, myRole, myChatwootAgentId, myHubspotOwnerId, ownerCache, ownerCacheReady]);

  // Group conversations by normalized phone — one entry per contact in the sidebar
  const groupedConversations = useMemo(() => {
    const map = new Map<string, any>();
    for (const c of displayedConversations) {
      const rawPhone = c.meta?.sender?.phone_number ?? "";
      const phone = normalizePhone(rawPhone) || rawPhone;
      const key = phone || `no-phone-${c.id}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, { ...c, _phone: phone, _convIds: [c.id] });
      } else {
        const convIds = [...existing._convIds, c.id];
        const mergedName = bestName(existing.meta?.sender?.name ?? "", c.meta?.sender?.name ?? "");
        const unread = (existing.unread_count ?? 0) + (c.unread_count ?? 0);
        // Base display on the most recent OPEN conversation; fall back to most recent overall
        const allInGroup = [existing, c];
        const openOnes = allInGroup.filter((x) => x.status === "open");
        const sortByActivity = (arr: any[]) => [...arr].sort((a, b) => (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0));
        const base = sortByActivity(openOnes.length ? openOnes : allInGroup)[0];
        const merged = { ...base, _phone: phone, _convIds: convIds, unread_count: unread };
        merged.meta = { ...merged.meta, sender: { ...merged.meta?.sender, name: mergedName } };
        map.set(key, merged);
      }
    }
    // Sort: 1) unread  2) awaiting response (last msg from lead)  3) rest by activity
    function convPriority(c: any): number {
      if ((c.unread_count ?? 0) > 0) return 0;
      if (c.last_message?.message_type === 0) return 1;
      return 2;
    }
    return Array.from(map.values()).sort((a, b) => {
      const pa = convPriority(a); const pb = convPriority(b);
      if (pa !== pb) return pa - pb;
      return (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0);
    });
  }, [displayedConversations]);

  useEffect(() => {
    const cacheKey = `berry_convs_${tab}`;
    // Show cached conversations immediately to avoid blank sidebar on load
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const { convs: cachedConvs, ts } = JSON.parse(cached);
        if (Date.now() - ts < 5 * 60_000 && Array.isArray(cachedConvs)) {
          setConversations(cachedConvs);
          setOwnerCacheReady(true); // cached data is good enough to show immediately
        }
      }
    } catch {}

    setLoadingConvs(true);
    setActiveId(null);
    setActivePhone(null);
    setMessages([]);
    setOwnerCacheReady(false);
    getChatwootConversations({ data: { status: tab } })
      .then((convs) => {
        const normalized = convs.map((c: any) => ({
          ...c,
          last_message: c.last_non_activity_message ?? c.last_message ?? null,
        }));
        setConversations(normalized);
        // Persist fresh conversations to localStorage
        try { localStorage.setItem(cacheKey, JSON.stringify({ convs: normalized, ts: Date.now() })); } catch {}
        // Batch-load owner cache for all conversations in this tab
        const phones = [...new Set(
          normalized.map((c: any) => normalizePhone(c.meta?.sender?.phone_number)).filter(Boolean)
        )] as string[];
        if (phones.length) {
          getContactOwnersBatch({ data: { phones } })
            .then((rows) => {
              const cached = new Set(rows.map((r) => r.phone));
              setOwnerCache((prev) => {
                const next = { ...prev };
                for (const r of rows) next[r.phone] = r.hubspot_owner_id;
                return next;
              });
              // Cache is ready — filter can now apply correctly
              setOwnerCacheReady(true);
              // Fetch owner from HubSpot for phones not yet in cache — collect all, update once
              const uncached = phones.filter((p) => !cached.has(p));
              if (uncached.length) {
                const runPreload = async () => {
                  const collected: Record<string, string | null> = {};
                  for (const phone of uncached) {
                    try {
                      const contact = await getHubSpotContactByPhone({
                        data: { phone, properties: ["hubspot_owner_id"] },
                      });
                      collected[phone] = contact?.properties?.hubspot_owner_id ?? null;
                    } catch (e) {
                      console.error("owner preload error", phone, e);
                      collected[phone] = null;
                    }
                  }
                  // Single state update to avoid cascade of re-renders
                  setOwnerCache((prev) => ({ ...prev, ...collected }));
                  // Persist to Supabase in batch via individual upserts (fire-and-forget)
                  for (const [phone, ownerId] of Object.entries(collected)) {
                    upsertContactOwnerCache({ data: { phone, hubspot_owner_id: ownerId } }).catch(console.error);
                  }
                };
                runPreload();
              }
            })
            .catch(() => setOwnerCacheReady(true)); // on error, unblock anyway
        } else {
          setOwnerCacheReady(true);
        }
        const convs2 = normalized;
        const pending = pendingConversationIdRef.current;
        if (pending) {
          const found = convs2.find((c: any) => c.id === pending);
          if (found) {
            setActiveId(pending);
            setActivePhone(normalizePhone(found.meta?.sender?.phone_number));
            pendingConversationIdRef.current = null;
            navigate({ to: "/", search: {}, replace: true });
          } else {
            // Conversation not in current tab — fetch it directly and switch tab
            getChatwootConversationById({ data: { conversationId: pending } })
              .then((conv: any) => {
                const convStatus: Tab = conv.status ?? "open";
                setConversations((prev) => {
                  if (prev.some((c) => c.id === conv.id)) return prev;
                  return [conv, ...prev];
                });
                setActiveId(conv.id);
                setActivePhone(normalizePhone(conv.meta?.sender?.phone_number));
                setTab(convStatus);
                pendingConversationIdRef.current = null;
                navigate({ to: "/", search: {}, replace: true });
              })
              .catch(console.error);
          }
        } else if (convs2.length > 0) {
          setActiveId(convs2[0].id);
          setActivePhone(normalizePhone(convs2[0]?.meta?.sender?.phone_number));
        }
      })
      .catch(console.error)
      .finally(() => setLoadingConvs(false));
  }, [tab]);

  useEffect(() => {
    // Clear draft and template state when switching conversations
    setDraft("");
    setDraftIsTemplate(false);
    setSelectedTemplate(null);
    setTemplateVars([]);
    setShowTemplatePicker(false);

    if (!activeId) { setMessages([]); setHistoryMessages([]); setHubContact(null); return; }

    const activeConv = conversations.find((c) => c.id === activeId) ?? searchAllConvs.find((c) => c.id === activeId);
    const phone = activePhone ?? normalizePhone(activeConv?.meta?.sender?.phone_number);

    setLoadingMsgs(true);

    const applyMsgResult = (result: { msgs: any[]; can_reply: boolean }, convId: number) => {
      setMessages(result.msgs);
      setConversations((prev) => prev.map((c) =>
        c.id === convId ? { ...c, can_reply: result.can_reply } : c
      ));
    };

    // Load current conversation messages (sync to history) + full contact history in parallel
    Promise.all([
      getChatwootMessages({ data: { conversationId: activeId, contactPhone: phone || undefined } }),
      phone ? getContactHistory({ data: { contactPhone: phone } }) : Promise.resolve([]),
    ])
      .then(([result, history]) => {
        applyMsgResult(result, activeId);
        setHistoryMessages(history);
        // If history is empty, trigger a backfill in the background
        if (phone && history.length === 0) {
          setBackfilling(true);
          backfillContactHistory({ data: { contactPhone: phone } })
            .then(() => getContactHistory({ data: { contactPhone: phone } }))
            .then(setHistoryMessages)
            .catch(() => {})
            .finally(() => setBackfilling(false));
        }
      })
      .catch(console.error)
      .finally(() => setLoadingMsgs(false));

    // Poll every 5s to pick up delivery status updates from WhatsApp webhooks
    const poll = setInterval(() => {
      getChatwootMessages({ data: { conversationId: activeId, contactPhone: phone || undefined } })
        .then((result) => {
          applyMsgResult(result, activeId);
          if (phone) getContactHistory({ data: { contactPhone: phone } }).then(setHistoryMessages).catch(() => {});
        })
        .catch(() => {});
    }, 10_000);

    setHubContact(null);
    setHubChangedFields(new Set());
    prevHubPropsRef.current = {};
    if (phone) {
      setHubLoading(true);
      getHubSpotContactByPhone({ data: { phone, properties: visibleFields.map((f) => f.name) } })
        .then((contact) => {
          setHubContact(contact);
          prevHubPropsRef.current = contact?.properties ?? {};
          // Update owner cache for this phone so the sidebar filter stays accurate
          const ownerId = contact?.properties?.hubspot_owner_id ?? null;
          setOwnerCache((prev) => ({ ...prev, [phone]: ownerId }));
          upsertContactOwnerCache({ data: { phone, hubspot_owner_id: ownerId } }).catch(console.error);
        })
        .catch(console.error)
        .finally(() => setHubLoading(false));
    } else {
      setHubLoading(false);
    }

    // HubSpot refresh every 5 minutes — detect and highlight changed fields
    const hubPoll = phone ? setInterval(() => {
      getHubSpotContactByPhone({ data: { phone, properties: visibleFields.map((f) => f.name) } })
        .then((contact) => {
          const prev = prevHubPropsRef.current;
          const next = contact?.properties ?? {};
          const changed = new Set<string>();
          for (const key of Object.keys(next)) {
            if (prev[key] !== undefined && String(prev[key]) !== String(next[key] ?? "")) {
              changed.add(key);
            }
          }
          if (changed.size > 0) {
            setHubChangedFields(changed);
            toast.info("HubSpot atualizado", { description: `${changed.size} campo(s) mudaram para este contato.` });
          }
          prevHubPropsRef.current = next;
          setHubContact(contact);
        })
        .catch(console.error);
    }, 5 * 60_000) : null;

    return () => { clearInterval(poll); if (hubPoll) clearInterval(hubPoll); };
  }, [activeId]);

  // Total unread across all visible conversations — drives document.title badge
  const totalUnread = useMemo(
    () => groupedConversations.reduce((n, c) => n + (c.unread_count ?? 0), 0),
    [groupedConversations]
  );

  // Update document title with unread badge
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) Berry Atendimento` : "Berry Atendimento";
  }, [totalUnread]);

  const visible = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return groupedConversations;

    // When searching, use all-status pool grouped by phone
    const pool = searchAllConvs.length > 0 ? searchAllConvs : groupedConversations;
    const map = new Map<string, any>();
    for (const c of pool) {
      const rawPhone = c.meta?.sender?.phone_number ?? "";
      const phone = normalizePhone(rawPhone) || rawPhone;
      const key = phone || `no-phone-${c.id}`;
      if (!map.has(key)) map.set(key, { ...c, _phone: phone, _convIds: [c.id] });
    }
    const allGrouped = Array.from(map.values());

    const qDigits = q.replace(/\D/g, "");
    return allGrouped.filter((c) => {
      const name = (c.meta?.sender?.name ?? "").toLowerCase();
      const preview = (c.last_message?.content ?? "").toLowerCase();
      const phoneNorm = (c._phone ?? "").replace(/\D/g, "");
      const phoneRaw = (c.meta?.sender?.phone_number ?? "").replace(/\D/g, "");
      const phoneMatch = qDigits.length >= 4 && (phoneNorm.includes(qDigits) || phoneRaw.includes(qDigits));
      return name.includes(q) || preview.includes(q) || phoneMatch;
    });
  }, [groupedConversations, searchAllConvs, search]);

  // If role=agent and the selected conversation is not in the filtered list, fix the selection
  // Exception: cross-status search results are valid even if not in the current tab
  useEffect(() => {
    if (myRole !== "agent" || myChatwootAgentId === null) return;
    if (activeId === null) return;
    const isInCurrentTab = groupedConversations.some((c) => c._convIds?.includes(activeId) ?? c.id === activeId);
    const isInSearchResults = searchAllConvs.some((c) => c.id === activeId);
    if (!isInCurrentTab && !isInSearchResults) {
      const first = groupedConversations[0];
      setActiveId(first?.id ?? null);
      setActivePhone(first?._phone ?? null);
    }
  }, [groupedConversations, searchAllConvs, activeId, myRole, myChatwootAgentId]);

  // Also look in searchAllConvs for cross-status conversations (e.g. resolved shown via search)
  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? searchAllConvs.find((c) => c.id === activeId) ?? null,
    [conversations, searchAllConvs, activeId]
  );

  // Scroll to bottom when messages load or conversation changes
  useEffect(() => {
    if (!loadingMsgs) {
      messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [activeId, loadingMsgs]);

  const displayMessages = useMemo(() => {
    function mapMsg(m: any, sourceConvId?: number) {
      const statusStr = m.status as string | undefined;
      const statusFromStr = statusStr === "read" ? 2
        : statusStr === "delivered" ? 1
        : statusStr === "sent" ? 0
        : statusStr === "failed" ? 3
        : undefined;
      const contentAttrs = m.content_attributes ?? {};
      return {
        id: (m.chatwoot_message_id ?? m.id) as number,
        chatwootMessageId: (m.chatwoot_message_id ?? m.id) as number,
        conversationId: (m.conversation_id ?? sourceConvId) as number,
        from: m.message_type === 1 ? ("agent" as const) : ("contact" as const),
        text: (m.content as string) || null,
        attachments: (m.attachments ?? []) as any[],
        at: m.created_at_chatwoot
          ? (m.created_at_chatwoot as string)
          : new Date((m.created_at as number) * 1000).toISOString(),
        deliveryStatus: (contentAttrs.whatsapp?.status as number | undefined)
          ?? (contentAttrs.status as number | undefined)
          ?? statusFromStr,
        errorCode: (contentAttrs.whatsapp?.errorCode as string | undefined)
          ?? (contentAttrs.error_code as string | undefined),
        errorMessage: (contentAttrs.whatsapp?.errorMessage as string | undefined)
          ?? (contentAttrs.error_message as string | undefined),
        fromHistory: !!m.created_at_chatwoot,
      };
    }

    // Build a deduplicated, chronologically sorted list from history + current messages
    const historyById = new Map<number, ReturnType<typeof mapMsg>>();
    for (const m of historyMessages) {
      if (m.message_type === 2) continue;
      if (!m.content && !(m.attachments?.length)) continue;
      historyById.set(m.chatwoot_message_id as number, mapMsg(m));
    }
    // Current conversation messages override history (fresher status)
    for (const m of messages) {
      if (m.message_type === 2) continue;
      if (!m.content && !(m.attachments?.length)) continue;
      historyById.set(m.id as number, mapMsg(m, activeId ?? undefined));
    }

    return Array.from(historyById.values())
      .sort((a, b) => a.at.localeCompare(b.at));
  }, [messages, historyMessages, activeId]);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachFile({ file, previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null });
    e.target.value = "";
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = [
        "audio/ogg;codecs=opus",
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
      ].find((t) => MediaRecorder.isTypeSupported(t));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      audioChunksRef.current = [];
      recordingCancelledRef.current = false;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recordingTimerRef.current) {
          clearInterval(recordingTimerRef.current);
          recordingTimerRef.current = null;
        }
        if (recordingCancelledRef.current) {
          audioChunksRef.current = [];
          return;
        }
        const blobType = mimeType ?? "audio/webm";
        const blob = new Blob(audioChunksRef.current, { type: blobType });
        const ext = blobType.includes("ogg") ? "ogg" : blobType.includes("mp4") ? "m4a" : "webm";
        const file = new File([blob], `audio-${Date.now()}.${ext}`, { type: blobType });
        setAttachFile({ file, previewUrl: URL.createObjectURL(blob) });
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setRecordingTime(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime((t) => t + 1);
      }, 1000);
    } catch (e) {
      console.error(e);
    }
  }

  function stopRecording() {
    recordingCancelledRef.current = false;
    mediaRecorderRef.current?.stop();
    setRecording(false);
  }

  function cancelRecording() {
    recordingCancelledRef.current = true;
    mediaRecorderRef.current?.stop();
    setRecording(false);
  }

  async function handleSend() {
    if (!activeId) return;
    const text = draft.trim();
    if (!text && !attachFile) return;

    lastSentRef.current = Date.now();

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
      } else if (draftIsTemplate && draftTemplateInfo) {
        await sendChatwootTemplate({
          data: {
            conversationId: activeId,
            templateName: draftTemplateInfo.tpl.name,
            language: draftTemplateInfo.tpl.language ?? "pt_BR",
            category: draftTemplateInfo.tpl.category ?? "MARKETING",
            templateBody: content,
            templateParams: draftTemplateInfo.params,
          },
        });
      } else {
        await sendChatwootMessage({ data: { conversationId: activeId, content } });
      }
      setDraft("");
      setDraftIsTemplate(false);
      setDraftTemplateInfo(null);
      // Auto-assign to sender if conversation has no assignee
      const currentConv = conversations.find((c) => c.id === activeId);
      if (myChatwootAgentId && !currentConv?.meta?.assignee?.id) {
        assignChatwootConversation({ data: { conversationId: activeId, assigneeId: myChatwootAgentId } }).catch(() => {});
      }
      const updated = await getChatwootMessages({ data: { conversationId: activeId } });
      setMessages(updated.msgs);
      setConversations((prev) => prev.map((c) =>
        c.id === activeId ? { ...c, can_reply: updated.can_reply } : c
      ));
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
    setDraftTemplateInfo({ tpl, params: vars });
    setShowTemplatePicker(false);
    setSelectedTemplate(null);
    setTemplateVars([]);
    setTemplateSearch("");
  }

  return (
    <div className="flex h-[calc(100vh-52px)]">
      {/* In-app push notification stack — bottom-right, persistent until closed */}
      {pushNotifs.length > 0 && (
        <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 w-80">
          {pushNotifs.map((n) => (
            <div
              key={n.id}
              className="flex items-start gap-3 rounded-xl border border-orange-200 dark:border-orange-900 bg-white dark:bg-[#1e1e1e] shadow-2xl p-4 animate-in slide-in-from-right-4 fade-in duration-300"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-orange-100 dark:bg-orange-900/40 text-orange-500">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
                  <path d="M1.5 8.67v8.58a3 3 0 003 3h15a3 3 0 003-3V8.67l-8.928 5.493a3 3 0 01-3.144 0L1.5 8.67z" />
                  <path d="M22.5 6.908V6.75a3 3 0 00-3-3h-15a3 3 0 00-3 3v.158l9.714 5.978a1.5 1.5 0 001.572 0L22.5 6.908z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-[#090909] dark:text-[#e8e8e8] truncate">{n.sender}</p>
                  <button
                    onClick={() => setPushNotifs((prev) => prev.filter((x) => x.id !== n.id))}
                    className="shrink-0 text-[#999] hover:text-[#090909] dark:hover:text-[#e8e8e8] transition-colors"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                      <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                    </svg>
                  </button>
                </div>
                <p className="mt-0.5 text-xs text-[#666] dark:text-[#909090] line-clamp-2">{n.preview || "Nova mensagem recebida"}</p>
                {n.convId && (
                  <button
                    onClick={() => {
                      setActiveId(n.convId!);
                      setPushNotifs((prev) => prev.filter((x) => x.id !== n.id));
                    }}
                    className="mt-2 text-[11px] font-semibold text-orange-500 hover:text-orange-600 transition-colors"
                  >
                    Ver conversa →
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Left: conversation list */}
      <aside className="flex w-[300px] flex-col border-r border-[#e5e5e5] dark:border-[#2a2a2a] bg-[#f8f8f8] dark:bg-[#1e1e1e]">
        <div className="border-b border-[#e5e5e5] dark:border-[#2a2a2a] p-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#666] dark:text-[#909090]" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar conversas"
                className="h-9 bg-white dark:bg-[#1a1a1a] pl-8"
              />
            </div>
            <button
              onClick={openNewConvModal}
              title="Nova conversa"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] text-[#666] dark:text-[#909090] transition-colors hover:border-[#090909] dark:hover:border-[#555] hover:text-[#090909] dark:hover:text-[#e8e8e8]"
            >
              <UserPlus className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex gap-5 border-b border-[#e5e5e5] dark:border-[#2a2a2a] px-3">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "relative py-3 text-sm transition-colors",
                tab === t.key ? "font-semibold text-[#090909] dark:text-[#e8e8e8]" : "text-[#666] dark:text-[#909090] hover:text-[#090909] dark:hover:text-[#e8e8e8]"
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
          {loadingConvs || searchLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-[#999] dark:text-[#686868]" />
            </div>
          ) : visible.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#666] dark:text-[#909090]">Sem conversas</div>
          ) : (() => {
            const unreadConvs = !search.trim() ? visible.filter((c) => (c.unread_count ?? 0) > 0) : [];
            const readConvs = !search.trim() ? visible.filter((c) => (c.unread_count ?? 0) === 0) : visible;
            const renderRow = (c: any) => (
              <ConversationRow
                key={c._phone ?? c.id}
                conv={c}
                active={c._convIds ? c._convIds.includes(activeId) : c.id === activeId}
                isResponded={respondedConvIds.has(c.id)}
                onClick={() => {
                  setActiveId(c.id);
                  setActivePhone(c._phone ?? null);
                  if ((c.unread_count ?? 0) > 0) {
                    markConversationRead({ data: { conversationId: c.id } }).catch(() => {});
                    setConversations((prev) =>
                      prev.map((x) => x.id === c.id ? { ...x, unread_count: 0 } : x)
                    );
                  }
                }}
                onMarkUnread={() => {
                  markConversationUnread({ data: { conversationId: c.id } }).catch(() => {});
                  setConversations((prev) =>
                    prev.map((x) => x.id === c.id ? { ...x, unread_count: 1 } : x)
                  );
                }}
                onMarkResponded={() => {
                  setRespondedConvIds((prev) => {
                    const next = new Set(prev); next.add(c.id);
                    localStorage.setItem("berry_responded", JSON.stringify([...next]));
                    return next;
                  });
                }}
              />
            );
            return (
              <>
                {unreadConvs.length > 0 && (
                  <>
                    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[#fff8e6] dark:bg-[#2a2200] border-b border-[#e5e5e5] dark:border-[#2a2a2a]">
                      <span className="h-1.5 w-1.5 rounded-full bg-orange-400 animate-pulse" />
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-orange-500 dark:text-orange-400">
                        Em atenção · {unreadConvs.length}
                      </span>
                    </div>
                    {unreadConvs.map(renderRow)}
                    {readConvs.length > 0 && (
                      <div className="px-3 py-1.5 border-b border-[#e5e5e5] dark:border-[#2a2a2a]">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-[#999] dark:text-[#686868]">
                          Todas · {readConvs.length}
                        </span>
                      </div>
                    )}
                  </>
                )}
                {readConvs.map(renderRow)}
              </>
            );
          })()}
        </div>
      </aside>

      {/* Center: chat */}
      <section className="flex flex-1 flex-col bg-white dark:bg-[#1a1a1a]">
        {!active ? (
          <EmptyChat />
        ) : (
          <>
            <header className="flex items-center justify-between border-b border-[#e5e5e5] dark:border-[#2a2a2a] px-6 py-3">
              <div className="flex items-center gap-3">
                <ContactAvatar
                  name={active.meta?.sender?.name ?? "?"}
                  src={active.meta?.sender?.avatar_url}
                  text="text-sm"
                />
                <div>
                  <div className="text-sm font-semibold text-[#090909] dark:text-[#e8e8e8]">
                    {active.meta?.sender?.name ?? "Desconhecido"}
                  </div>
                  <div className="text-xs text-[#666] dark:text-[#909090]">{active.meta?.sender?.phone_number ?? ""}</div>
                </div>
                <StatusBadge status={active.status} />
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const next = !soundEnabled;
                    setSoundEnabled(next);
                    localStorage.setItem("berry_sound", next ? "on" : "off");
                  }}
                  title={soundEnabled ? "Silenciar notificações" : "Ativar notificações"}
                  className="rounded-md p-1.5 text-[#666] dark:text-[#909090] hover:bg-[#f0f0f0] dark:hover:bg-[#252525] hover:text-[#090909] dark:hover:text-[#e8e8e8]"
                >
                  {soundEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                </button>
                {active.status !== "resolved" && (
                  <Button
                    size="sm"
                    className="bg-[#00e186] text-[#090909] dark:text-[#e8e8e8] hover:bg-[#00c875]"
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
              {backfilling && (
                <div className="flex items-center gap-2 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 px-3 py-2 text-[11px] text-blue-600 dark:text-blue-400">
                  <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                  <span>Carregando histórico completo do contato…</span>
                </div>
              )}
              {loadingMsgs ? (
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-[#999] dark:text-[#686868]" />
                </div>
              ) : (
                displayMessages.map((m, idx) => {
                  const isAgent = m.from === "agent";
                  const emojiOnly = m.text && isEmojiOnly(m.text) && m.attachments.length === 0;
                  const { name: agentHeader, body: agentBody } =
                    isAgent && m.text ? parseAgentHeader(m.text) : { name: null, body: m.text };

                  // Separator when conversation changes
                  const prevMsg = idx > 0 ? displayMessages[idx - 1] : null;
                  const convChanged = prevMsg && prevMsg.conversationId !== m.conversationId;
                  const separator = convChanged ? (
                    <div key={`sep-${m.conversationId}`} className="flex items-center gap-3 py-1">
                      <div className="flex-1 border-t border-dashed border-[#e5e5e5] dark:border-[#2a2a2a]" />
                      <span className="text-[10px] text-[#aaa] dark:text-[#555] whitespace-nowrap">
                        Nova conversa · {new Date(m.at).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" })}
                      </span>
                      <div className="flex-1 border-t border-dashed border-[#e5e5e5] dark:border-[#2a2a2a]" />
                    </div>
                  ) : null;

                  if (emojiOnly) {
                    return (
                      <div key={m.id}>
                        {separator}
                        <div className={cn("flex", isAgent ? "justify-end" : "justify-start")}>
                          <div>
                            <div className="text-3xl leading-none">{m.text}</div>
                            <div className={cn("mt-1 flex items-center gap-1 text-[11px] text-[#666] dark:text-[#909090]", isAgent ? "justify-end" : "justify-start")}>
                              <span>{fmtBRT(m.at)}</span>
                              {isAgent && (
                                <MessageStatus
                                  status={m.deliveryStatus}
                                  errorCode={m.errorCode}
                                  errorMessage={m.errorMessage}
                                />
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  }

                  const canDeleteHistory = agentEmail === "leonardo.villas@berry.com.br" && m.fromHistory;

                  return (
                    <div key={m.id}>
                      {separator}
                    <div className={cn("flex group/msg", isAgent ? "justify-end" : "justify-start")}>
                      <div className="max-w-[70%]">
                        {/* Text bubble */}
                        {m.text && (
                          <div className={cn(
                            "rounded-2xl px-4 py-2.5 text-sm",
                            isAgent ? "bg-[#090909] text-white" : "border border-[#e5e5e5] dark:border-[#2a2a2a] bg-[#f8f8f8] dark:bg-[#1e1e1e] text-[#090909] dark:text-[#e8e8e8]"
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
                                isAgent ? "bg-[#090909] text-white" : "border border-[#e5e5e5] dark:border-[#2a2a2a] bg-[#f8f8f8] dark:bg-[#1e1e1e] text-[#090909] dark:text-[#e8e8e8]"
                              )}
                            >
                              📎 {att.file_name ?? "Arquivo"}
                            </a>
                          );
                        })}

                        {/* Error banner for failed messages */}
                        {(m.errorCode || m.deliveryStatus === 3) && (
                          <div className="mt-1 flex items-start justify-between gap-2 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 px-2.5 py-1.5 text-[11px] text-red-600 dark:text-red-400">
                            <div className="flex items-start gap-1.5">
                              <AlertCircle className="h-3 w-3 mt-px shrink-0" />
                              <span>
                                {m.errorMessage
                                  ? `Erro ${m.errorCode ? `${m.errorCode}: ` : ""}${m.errorMessage}`
                                  : `Erro ${m.errorCode ?? ""}: mensagem não entregue`}
                              </span>
                            </div>
                            <button
                              title="Reenviar mensagem"
                              onClick={async () => {
                                try {
                                  await retryChatwootMessage({ data: { conversationId: m.conversationId ?? active!.id, messageId: m.chatwootMessageId } });
                                  const updated = await getChatwootMessages({ data: { conversationId: active!.id } });
                                  setMessages(updated.msgs);
                                } catch {
                                  // retry may not be supported for all channel types
                                }
                              }}
                              className="shrink-0 rounded p-0.5 hover:bg-red-100 dark:hover:bg-red-900/40"
                            >
                              <RotateCcw className="h-3 w-3" />
                            </button>
                          </div>
                        )}

                        <div className={cn("mt-1 flex items-center gap-1 text-[11px] text-[#666] dark:text-[#909090]", isAgent ? "justify-end" : "justify-start")}>
                          <span>{fmtBRT(m.at)}</span>
                          {isAgent && (
                            <MessageStatus
                              status={m.deliveryStatus}
                              errorCode={m.errorCode}
                              errorMessage={m.errorMessage}
                            />
                          )}
                        </div>
                      </div>

                      {/* Delete from history — only visible to leonardo.villas@berry.com.br */}
                      {canDeleteHistory && (
                        <button
                          title="Apagar do histórico"
                          onClick={async () => {
                            await deleteHistoryMessage({ data: { chatwootMessageId: m.id } });
                            const phone = activePhone ?? normalizePhone(
                              (conversations.find((c) => c.id === activeId) ?? searchAllConvs.find((c) => c.id === activeId))?.meta?.sender?.phone_number
                            );
                            if (phone) getContactHistory({ data: { contactPhone: phone } }).then(setHistoryMessages).catch(() => {});
                          }}
                          className={cn(
                            "self-end mb-1 shrink-0 rounded p-1 opacity-0 transition-opacity group-hover/msg:opacity-100",
                            isAgent ? "mr-2 order-first" : "ml-2",
                            "text-[#aaa] hover:text-red-500 dark:text-[#555] dark:hover:text-red-400"
                          )}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="border-t border-[#e5e5e5] dark:border-[#2a2a2a] px-6 py-4">
              {/* 24h window warning — only for open conversations */}
              {active && active.can_reply === false && active.status === "open" && (
                <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span>Fora da janela de 24h — use um template para iniciar a conversa.</span>
                </div>
              )}
              {/* File preview */}
              {attachFile && attachFile.file.type.startsWith("audio/") ? (
                <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-[#e5e5e5] dark:border-[#2a2a2a] bg-[#f8f8f8] dark:bg-[#1e1e1e] px-3 py-2">
                  <div className="flex-1">
                    <AudioPlayer src={attachFile.previewUrl!} fromAgent />
                  </div>
                  <button
                    onClick={() => { if (attachFile.previewUrl) URL.revokeObjectURL(attachFile.previewUrl); setAttachFile(null); }}
                    className="shrink-0 text-[#999] dark:text-[#686868] hover:text-[#090909] dark:hover:text-[#e8e8e8]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : attachFile ? (
                <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-[#e5e5e5] dark:border-[#2a2a2a] bg-[#f8f8f8] dark:bg-[#1e1e1e] px-3 py-2">
                  {attachFile.previewUrl ? (
                    <img src={attachFile.previewUrl} className="h-10 w-10 rounded-lg object-cover" alt="" />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#e5e5e5] dark:bg-[#2a2a2a] text-lg">
                      📄
                    </div>
                  )}
                  <span className="flex-1 truncate text-xs text-[#666] dark:text-[#909090]">{attachFile.file.name}</span>
                  <button onClick={() => setAttachFile(null)} className="shrink-0 text-[#999] dark:text-[#686868] hover:text-[#090909] dark:hover:text-[#e8e8e8]">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : null}

              {recording ? (
                <div className="flex items-center gap-3 rounded-xl border border-[#e5e5e5] dark:border-[#2a2a2a] bg-[#f8f8f8] dark:bg-[#1e1e1e] px-4 py-2.5">
                  <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
                  <span className="text-sm text-[#090909] dark:text-[#e8e8e8]">Gravando…</span>
                  <span className="font-mono text-sm text-[#666] dark:text-[#909090]">{formatAudioTime(recordingTime)}</span>
                  <div className="flex-1" />
                  <button
                    onClick={cancelRecording}
                    title="Cancelar"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[#888] dark:text-[#686868] hover:bg-[#f0f0f0] dark:hover:bg-[#252525] hover:text-[#090909] dark:hover:text-[#e8e8e8]"
                  >
                    <X className="h-[18px] w-[18px]" />
                  </button>
                  <button
                    onClick={stopRecording}
                    title="Parar e revisar"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#090909] text-white hover:bg-[#090909]/90"
                  >
                    <Square className="h-4 w-4" />
                  </button>
                </div>
              ) : (
              <div className="flex items-center gap-1.5">
                {/* Attach */}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[#888] dark:text-[#686868] hover:bg-[#f0f0f0] dark:hover:bg-[#252525] hover:text-[#090909] dark:hover:text-[#e8e8e8]"
                >
                  <Paperclip className="h-[18px] w-[18px]" />
                </button>

                {/* Record audio */}
                <button
                  onClick={startRecording}
                  title="Gravar áudio"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[#888] dark:text-[#686868] hover:bg-[#f0f0f0] dark:hover:bg-[#252525] hover:text-[#090909] dark:hover:text-[#e8e8e8]"
                >
                  <Mic className="h-[18px] w-[18px]" />
                </button>

                {/* Emoji picker */}
                <div ref={emojiPickerRef} className="relative shrink-0">
                  <button
                    onClick={() => setShowEmojiPicker((v) => !v)}
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-[#888] dark:text-[#686868] hover:bg-[#f0f0f0] dark:hover:bg-[#252525] hover:text-[#090909] dark:hover:text-[#e8e8e8]"
                  >
                    <Smile className="h-[18px] w-[18px]" />
                  </button>
                  {showEmojiPicker && (
                    <div className="absolute bottom-full left-0 mb-2 grid w-[300px] grid-cols-10 gap-0.5 rounded-xl border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] p-2 shadow-xl">
                      {COMMON_EMOJIS.map((em) => (
                        <button
                          key={em}
                          onClick={() => { setDraft((d) => d + em); setShowEmojiPicker(false); }}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-lg hover:bg-[#f0f0f0] dark:hover:bg-[#252525]"
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
                      "flex h-9 w-9 items-center justify-center rounded-lg hover:bg-[#f0f0f0] dark:hover:bg-[#252525]",
                      showTemplatePicker ? "bg-[#f0f0f0] dark:bg-[#252525] text-[#090909] dark:text-[#e8e8e8]" : "text-[#888] dark:text-[#686868] hover:text-[#090909] dark:hover:text-[#e8e8e8]"
                    )}
                  >
                    <LayoutTemplate className="h-[18px] w-[18px]" />
                  </button>

                  {showTemplatePicker && (
                    <div className="absolute bottom-full left-0 z-30 mb-2 w-[400px] overflow-hidden rounded-xl border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] shadow-2xl">
                      {selectedTemplate ? (
                        /* Variable fill form */
                        <div className="p-4">
                          <button
                            onClick={() => setSelectedTemplate(null)}
                            className="mb-3 flex items-center gap-1 text-xs text-[#666] dark:text-[#909090] hover:text-[#090909] dark:hover:text-[#e8e8e8]"
                          >
                            <ChevronLeft className="h-3.5 w-3.5" />
                            {selectedTemplate.name}
                          </button>
                          <div className="space-y-3 mb-4">
                            {templateVars.map((v, i) => (
                              <div key={i} className="space-y-1">
                                <label className="text-[11px] font-semibold uppercase tracking-wider text-[#666] dark:text-[#909090]">
                                  Variável {i + 1}
                                </label>
                                <input
                                  autoFocus={i === 0}
                                  value={v}
                                  onChange={(e) => {
                                    const next = [...templateVars];
                                    next[i] = e.target.value;
                                    setTemplateVars(next);
                                  }}
                                  placeholder={`{{${i + 1}}}`}
                                  className="h-9 w-full rounded-md border border-[#e5e5e5] dark:border-[#2a2a2a] px-3 text-sm focus:outline-none focus:ring-1 focus:ring-[#090909] dark:focus:ring-[#888]"
                                />
                              </div>
                            ))}
                          </div>
                          {/* Live preview */}
                          <div className="mb-4">
                            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[#666] dark:text-[#909090]">Prévia</div>
                            <div className="whitespace-pre-wrap rounded-lg bg-[#f0faf5] dark:bg-[#0d2018] border border-[#00e186]/30 p-3 text-xs text-[#090909] dark:text-[#e8e8e8]">
                              {(() => {
                                let body = getTplBody(selectedTemplate);
                                templateVars.forEach((v, i) => {
                                  body = body.replaceAll(`{{${i + 1}}}`, v || `{{${i + 1}}}`);
                                });
                                return body;
                              })()}
                            </div>
                          </div>
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => setSelectedTemplate(null)}
                              className="rounded-md border border-[#e5e5e5] dark:border-[#2a2a2a] px-3 py-1.5 text-xs hover:bg-[#f0f0f0] dark:hover:bg-[#252525]"
                            >
                              Voltar
                            </button>
                            <button
                              onClick={() => applyTemplate(selectedTemplate, templateVars)}
                              disabled={templateVars.some((v) => !v.trim())}
                              className="rounded-md bg-[#090909] px-3 py-1.5 text-xs text-white hover:bg-[#090909]/90 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              Usar template
                            </button>
                          </div>
                        </div>
                      ) : (
                        /* Template list */
                        <>
                          <div className="border-b border-[#e5e5e5] dark:border-[#2a2a2a] p-2">
                            <div className="relative">
                              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#999] dark:text-[#686868]" />
                              <input
                                autoFocus
                                value={templateSearch}
                                onChange={(e) => setTemplateSearch(e.target.value)}
                                placeholder="Buscar template…"
                                className="w-full rounded-lg border border-[#e5e5e5] dark:border-[#2a2a2a] py-1.5 pl-8 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-[#090909] dark:focus:ring-[#888]"
                              />
                            </div>
                          </div>
                          <div className="max-h-[320px] overflow-y-auto">
                            {templatesLoading ? (
                              <div className="flex items-center justify-center py-10">
                                <Loader2 className="h-4 w-4 animate-spin text-[#999] dark:text-[#686868]" />
                              </div>
                            ) : filteredTemplates.length === 0 ? (
                              <p className="py-10 text-center text-sm text-[#999] dark:text-[#686868]">
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
                                    className="w-full border-b border-[#f0f0f0] px-4 py-3 text-left transition-colors hover:bg-[#f8f8f8] dark:hover:bg-[#1e1e1e] last:border-0"
                                  >
                                    <div className="mb-0.5 flex items-center justify-between gap-2">
                                      <span className="text-xs font-semibold text-[#090909] dark:text-[#e8e8e8]">{t.name}</span>
                                      <span className="shrink-0 rounded-full bg-[#f0f0f0] dark:bg-[#252525] px-2 py-0.5 text-[10px] text-[#666] dark:text-[#909090]">
                                        {t.language}
                                      </span>
                                    </div>
                                    <p className="line-clamp-2 text-xs text-[#666] dark:text-[#909090]">{body}</p>
                                    {numVars > 0 && (
                                      <p className="mt-1 text-[10px] text-[#aaa] dark:text-[#626262]">{numVars} variável{numVars > 1 ? "is" : ""}</p>
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
                  placeholder={active?.can_reply === false && active?.status === "open" ? "Use um template para responder…" : "Digite uma mensagem…"}
                  disabled={!draftIsTemplate && active?.can_reply === false && active?.status === "open"}
                  className="h-11 flex-1"
                />
                <Button
                  size="icon"
                  className="h-11 w-11 shrink-0 bg-[#090909] text-white hover:bg-[#090909]/90"
                  onClick={handleSend}
                  disabled={sending || (!draft.trim() && !attachFile) || (!draftIsTemplate && active?.can_reply === false && active?.status === "open")}
                >
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
              )}

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
      <aside className="w-[320px] overflow-y-auto border-l border-[#e5e5e5] dark:border-[#2a2a2a] p-4 bg-[#f8f8f8] dark:bg-[#1e1e1e]">
        {active ? (
          <LeadPanel
            conv={active}
            messages={messages}
            hubContact={hubContact}
            hubLoading={hubLoading}
            hubChangedFields={hubChangedFields}
            visibleFields={visibleFields}
            onHubRefresh={async () => {
              const phone = activePhone ?? normalizePhone(active?.meta?.sender?.phone_number);
              if (!phone) return;
              setHubLoading(true);
              try {
                const contact = await getHubSpotContactByPhone({ data: { phone, properties: visibleFields.map((f) => f.name) } });
                const prev = prevHubPropsRef.current;
                const next = contact?.properties ?? {};
                const changed = new Set<string>();
                for (const key of Object.keys(next)) {
                  if (prev[key] !== undefined && String(prev[key]) !== String(next[key] ?? "")) changed.add(key);
                }
                if (changed.size > 0) setHubChangedFields(changed);
                prevHubPropsRef.current = next;
                setHubContact(contact);
              } finally {
                setHubLoading(false);
              }
            }}
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
          <div className="relative flex max-h-[85vh] w-[480px] flex-col overflow-hidden rounded-2xl bg-white dark:bg-[#1a1a1a] shadow-2xl">

            {/* Header */}
            <div className="flex items-center justify-between border-b border-[#e5e5e5] dark:border-[#2a2a2a] px-6 py-4">
              <div>
                <p className="text-xs text-[#999] dark:text-[#686868]">Iniciar conversa via template</p>
                <h2 className="text-base font-semibold text-[#090909] dark:text-[#e8e8e8]">
                  {newConvStep === "contact" && "Novo contato"}
                  {newConvStep === "template" && "Selecionar template"}
                  {newConvStep === "vars" && (newConvTemplate?.name ?? "Confirmar envio")}
                </h2>
              </div>
              <button
                onClick={() => setNewConvModal(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-[#999] dark:text-[#686868] hover:bg-[#f0f0f0] dark:hover:bg-[#252525] hover:text-[#090909] dark:hover:text-[#e8e8e8]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Step 1: contact info */}
            {newConvStep === "contact" && (
              <div className="space-y-4 p-6">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-[#666] dark:text-[#909090]">Nome</label>
                  <input
                    autoFocus
                    value={newConvName}
                    onChange={(e) => setNewConvName(e.target.value)}
                    placeholder="Nome completo do contato"
                    className="h-10 w-full rounded-lg border border-[#e5e5e5] dark:border-[#2a2a2a] px-3 text-sm focus:outline-none focus:ring-1 focus:ring-[#090909] dark:focus:ring-[#888]"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-[#666] dark:text-[#909090]">Telefone</label>
                  <input
                    value={newConvPhone}
                    onChange={(e) => setNewConvPhone(e.target.value)}
                    placeholder="+55 11 99999-9999"
                    type="tel"
                    className="h-10 w-full rounded-lg border border-[#e5e5e5] dark:border-[#2a2a2a] px-3 text-sm focus:outline-none focus:ring-1 focus:ring-[#090909] dark:focus:ring-[#888]"
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
                <div className="border-b border-[#e5e5e5] dark:border-[#2a2a2a] p-3">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#999] dark:text-[#686868]" />
                    <input
                      autoFocus
                      value={newConvTplSearch}
                      onChange={(e) => setNewConvTplSearch(e.target.value)}
                      placeholder="Buscar template…"
                      className="w-full rounded-lg border border-[#e5e5e5] dark:border-[#2a2a2a] py-1.5 pl-8 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-[#090909] dark:focus:ring-[#888]"
                    />
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                  {templatesLoading ? (
                    <div className="flex items-center justify-center py-16">
                      <Loader2 className="h-4 w-4 animate-spin text-[#999] dark:text-[#686868]" />
                    </div>
                  ) : filteredNewConvTemplates.length === 0 ? (
                    <p className="py-16 text-center text-sm text-[#999] dark:text-[#686868]">
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
                          className="w-full border-b border-[#f0f0f0] px-5 py-3.5 text-left transition-colors hover:bg-[#f8f8f8] dark:hover:bg-[#1e1e1e] last:border-0"
                        >
                          <div className="mb-0.5 flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-[#090909] dark:text-[#e8e8e8]">{t.name}</span>
                            <span className="shrink-0 rounded-full bg-[#f0f0f0] dark:bg-[#252525] px-2 py-0.5 text-[10px] text-[#666] dark:text-[#909090]">{t.language}</span>
                          </div>
                          <p className="line-clamp-2 text-xs text-[#666] dark:text-[#909090]">{body}</p>
                          {numVars > 0 && (
                            <p className="mt-0.5 text-[10px] text-[#aaa] dark:text-[#626262]">{numVars} variável{numVars > 1 ? "is" : ""}</p>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
                <div className="border-t border-[#e5e5e5] dark:border-[#2a2a2a] px-5 py-3">
                  <button
                    onClick={() => setNewConvStep("contact")}
                    className="flex items-center gap-1 text-xs text-[#666] dark:text-[#909090] hover:text-[#090909] dark:hover:text-[#e8e8e8]"
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
                  <div className="flex gap-8 rounded-lg bg-[#f8f8f8] dark:bg-[#1e1e1e] px-4 py-3 text-sm">
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-[#999] dark:text-[#686868]">Nome</div>
                      <div className="text-[#090909] dark:text-[#e8e8e8]">{newConvName}</div>
                    </div>
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-[#999] dark:text-[#686868]">Telefone</div>
                      <div className="text-[#090909] dark:text-[#e8e8e8]">{newConvPhone}</div>
                    </div>
                  </div>

                  {/* Template body */}
                  <div className="whitespace-pre-wrap rounded-lg border border-[#e5e5e5] dark:border-[#2a2a2a] bg-[#f8f8f8] dark:bg-[#1e1e1e] px-4 py-3 text-xs text-[#090909] dark:text-[#e8e8e8]">
                    {getTplBody(newConvTemplate)}
                  </div>

                  {/* Variable fields */}
                  {newConvVars.length > 0 && (
                    <div className="space-y-3">
                      {newConvVars.map((v, i) => (
                        <div key={i} className="space-y-1">
                          <label className="text-[11px] font-semibold uppercase tracking-wider text-[#666] dark:text-[#909090]">
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
                            className="h-9 w-full rounded-md border border-[#e5e5e5] dark:border-[#2a2a2a] px-3 text-sm focus:outline-none focus:ring-1 focus:ring-[#090909] dark:focus:ring-[#888]"
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {newConvError && (
                    <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{newConvError}</p>
                  )}
                </div>

                <div className="flex items-center justify-between border-t border-[#e5e5e5] dark:border-[#2a2a2a] px-5 py-3">
                  <button
                    onClick={() => { setNewConvStep("template"); setNewConvTemplate(null); }}
                    className="flex items-center gap-1 text-xs text-[#666] dark:text-[#909090] hover:text-[#090909] dark:hover:text-[#e8e8e8]"
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

function ConversationRow({ conv, active, onClick, onMarkUnread, onMarkResponded, isResponded }: { conv: any; active: boolean; onClick: () => void; onMarkUnread: () => void; onMarkResponded: () => void; isResponded: boolean }) {
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const name = conv.meta?.sender?.name ?? "Desconhecido";
  const preview = conv.last_message?.content ?? "";
  const updatedAt = conv.last_activity_at
    ? new Date(conv.last_activity_at * 1000).toISOString()
    : new Date().toISOString();
  const unread = (conv.unread_count ?? 0) > 0;
  const awaitingReply = !unread && !isResponded && conv.last_message?.message_type === 0;

  return (
    <div
      className={cn(
        "relative flex w-full items-start gap-3 border-b border-[#e5e5e5] dark:border-[#2a2a2a] px-3 py-3 text-left transition-colors cursor-pointer",
        active ? "bg-white dark:bg-[#1a1a1a]" : "hover:bg-white/60 dark:hover:bg-[#252525]"
      )}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <ContactAvatar name={name} src={conv.meta?.sender?.avatar_url} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold text-[#090909] dark:text-[#e8e8e8]">{name}</span>
          <span className="shrink-0 text-[11px] text-[#666] dark:text-[#909090]">{timeAgo(updatedAt)}</span>
        </div>
        {awaitingReply && (
          <span className="mt-0.5 inline-block text-[10px] text-[#999] dark:text-[#686868]">
            Aguardando resposta
          </span>
        )}
        <p className="truncate text-xs text-[#666] dark:text-[#909090]">{preview}</p>
      </div>
      <div className="mt-0.5 flex shrink-0 items-center gap-1">
        {hovered && (
          <>
            {awaitingReply && (
              <button
                title="Marcar como respondido"
                onClick={(e) => { e.stopPropagation(); onMarkResponded(); }}
                className="rounded p-0.5 text-[#999] hover:text-[#090909] dark:hover:text-[#e8e8e8] transition-colors"
              >
                <Check className="h-3 w-3" />
              </button>
            )}
            <button
              title="Copiar link da conversa"
              onClick={(e) => {
                e.stopPropagation();
                const url = `${window.location.origin}/?conversationId=${conv.id}`;
                navigator.clipboard.writeText(url).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
              className="rounded p-0.5 text-[#999] hover:text-[#090909] dark:hover:text-[#e8e8e8] transition-colors"
            >
              {copied ? <Check className="h-3 w-3" /> : <Link className="h-3 w-3" />}
            </button>
            {!unread && (
              <button
                title="Marcar como não lida"
                onClick={(e) => { e.stopPropagation(); onMarkUnread(); }}
                className="rounded p-0.5 text-[#999] hover:text-[#090909] dark:hover:text-[#e8e8e8] transition-colors"
              >
                <span className="h-2 w-2 block rounded-full border-2 border-current" />
              </button>
            )}
          </>
        )}
        {unread && (
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: "#00e186" }} />
        )}
      </div>
    </div>
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
  conv, messages, hubContact, hubLoading, hubChangedFields, visibleFields, onHubRefresh, onConvUpdate,
}: {
  conv: any;
  messages: any[];
  hubContact: any | null;
  hubLoading: boolean;
  hubChangedFields: Set<string>;
  visibleFields: HsField[];
  onHubRefresh: () => Promise<void>;
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
      <div className="rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] p-4">
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
            <div className="truncate font-semibold text-[#090909] dark:text-[#e8e8e8]">{name}</div>
            {phone && <div className="truncate text-xs text-[#666] dark:text-[#909090]">{phone}</div>}
            {email && <div className="truncate text-xs text-[#666] dark:text-[#909090]">{email}</div>}
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
              className="absolute -right-3 -top-3 flex h-8 w-8 items-center justify-center rounded-full bg-white dark:bg-[#1a1a1a] text-[#090909] dark:text-[#e8e8e8] shadow-lg hover:bg-[#f0f0f0] dark:hover:bg-[#252525]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {hubLoading ? (
        <div className="rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] p-4">
          <div className="flex items-center gap-2 text-xs text-[#999] dark:text-[#686868]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Buscando no HubSpot…
          </div>
        </div>
      ) : hubContact ? (
        <div className="rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="label-uppercase">HubSpot CRM</span>
            <div className="flex items-center gap-2">
              {hubContact?.id && (
                <button
                  onClick={async () => {
                    const result = await debugHubSpotContact({
                      data: { contactId: String(hubContact.id), properties: visibleFields.map((f) => f.name) }
                    });
                    console.log("[HubSpot Debug]", result);
                    if (result.leadId) {
                      toast.info(`Lead associado: ${result.leadId}`, {
                        description: result.leadProperties
                          ? `Propriedades do Lead: ${JSON.stringify(result.leadProperties)}`
                          : "Lead sem propriedades visíveis"
                      });
                    } else {
                      toast.info("Sem Lead associado a este contato", {
                        description: "Os dados vêm direto do objeto Contact"
                      });
                    }
                  }}
                  title="Diagnóstico: verificar origem dos campos"
                  className="text-[#bbb] hover:text-[#090909] dark:hover:text-[#e8e8e8] transition-colors text-[10px] font-mono"
                >
                  debug
                </button>
              )}
              <button
                onClick={onHubRefresh}
                disabled={hubLoading}
                title="Atualizar dados do HubSpot"
                className="text-[#999] hover:text-[#090909] dark:hover:text-[#e8e8e8] transition-colors disabled:opacity-40"
              >
                <RotateCcw className={cn("h-3.5 w-3.5", hubLoading && "animate-spin")} />
              </button>
            </div>
          </div>
          <div className="space-y-2.5 text-sm">
            {visibleFields.map((f) => {
              const value = hubContact.properties?.[f.name];
              if (!value) return null;
              const isOwnerField = f.name === "hubspot_owner_id" || f.referencedObjectType === "OWNER"
                || (Object.keys(ownersMap).length > 0 && ownersMap[String(value)] !== undefined);
              const display = isOwnerField
                ? (ownersMap[String(value)] ?? String(value))
                : formatHsValue(String(value));
              const changed = hubChangedFields.has(f.name);
              return <Field key={f.name} label={f.label} value={display} changed={changed} />;
            })}
          </div>
        </div>
      ) : null}

      {hubContact && (
        <div className="rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] p-4">
          <div className="label-uppercase mb-3">Observações</div>

          {notesLoading ? (
            <div className="flex items-center gap-2 text-xs text-[#999] dark:text-[#686868]">
              <Loader2 className="h-3 w-3 animate-spin" />
              Carregando…
            </div>
          ) : notes.length > 0 ? (
            <div className="mb-3 max-h-[220px] space-y-2 overflow-y-auto pr-0.5">
              {notes.map((n) => (
                <div key={n.id} className="rounded-lg bg-[#f8f8f8] dark:bg-[#1e1e1e] px-3 py-2">
                  <div className="mb-1 text-[10px] text-[#999] dark:text-[#686868]">
                    {formatHsValue(n.properties.hs_timestamp)}
                  </div>
                  <div className="whitespace-pre-wrap text-xs text-[#090909] dark:text-[#e8e8e8]">
                    {stripHtml(n.properties.hs_note_body ?? "")}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mb-3 text-xs text-[#999] dark:text-[#686868]">Nenhuma observação ainda.</p>
          )}

          <textarea
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && e.metaKey) saveNote(); }}
            placeholder="Nova observação… (⌘Enter para salvar)"
            rows={3}
            className="w-full resize-none rounded-lg border border-[#e5e5e5] dark:border-[#2a2a2a] px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-[#090909] dark:focus:ring-[#888]"
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
      <div className="rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] p-4">
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
              <span className="text-sm text-[#090909] dark:text-[#e8e8e8]">{conv.meta.assignee.name}</span>
            </>
          ) : (
            <span className="text-sm text-[#999] dark:text-[#686868]">Não atribuído</span>
          )}
        </div>

        {/* Dropdown + botão */}
        <div className="flex gap-2">
          <select
            value={selectedAgentId}
            onChange={(e) => setSelectedAgentId(e.target.value)}
            className="flex-1 rounded-md border border-[#e5e5e5] dark:border-[#2a2a2a] px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-[#090909] dark:focus:ring-[#888]"
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
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[#999] dark:text-[#686868]">Histórico</p>
            {activityLog.map((m) => (
              <div key={m.id} className="text-[11px] text-[#999] dark:text-[#686868]">
                <span className="text-[#ccc] dark:text-[#505050]">{timeAgo(new Date((m.created_at as number) * 1000).toISOString())} atrás</span>
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

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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

function Field({ label, value, changed }: { label: string; value: string; changed?: boolean }) {
  return (
    <div className={changed ? "rounded-md bg-amber-50 dark:bg-amber-900/20 px-2 py-1 -mx-2" : ""}>
      <div className="flex items-center gap-1.5">
        <span className="label-uppercase mb-0.5">{label}</span>
        {changed && <span className="mb-0.5 rounded-full bg-amber-400 px-1.5 py-0.5 text-[9px] font-bold uppercase text-amber-900">Atualizado</span>}
      </div>
      <div className="font-medium text-[#090909] dark:text-[#e8e8e8]">{value}</div>
    </div>
  );
}

function EmptyChat() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center text-sm text-[#666] dark:text-[#909090]">
      <UserPlus className="mb-3 h-10 w-10 text-[#c0c0c0] dark:text-[#505050]" />
      Selecione uma conversa para começar
    </div>
  );
}
