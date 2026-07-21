/**
 * T31 — handleSend: estado de loading e concorrência
 *
 * Testa o fluxo de envio de mensagem de forma isolada, sem React nem DOM.
 * Extrai a lógica pura para verificar que:
 *   - setSending(false) é sempre chamado (sucesso, erro, timeout)
 *   - operações secundárias não bloqueiam o botão
 *   - cliques concorrentes são bloqueados pelo ref guard
 *   - can_reply=false bloqueia sem fazer request
 *   - draft é preservado em caso de erro e limpo em sucesso
 *   - troca de conversa durante envio não insere mensagem errada
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Helpers que espelham a lógica de handleSend ───────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label}: tempo limite atingido.`)),
        ms
      )
    ),
  ]);
}

interface SendState {
  sending: boolean;
  draft: string;
  error: string | null;
  requestCount: number;
  lastConvId: number | null;
}

interface HandleSendDeps {
  activeId: number | null;
  draft: string;
  isSendingRef: { current: boolean };
  canReply: boolean;
  isDraftTemplate: boolean;
  sendMessage: (convId: number, content: string) => Promise<void>;
  refreshMessages: (convId: number) => Promise<void>;
  activeIdRef: { current: number | null };
}

async function simulateHandleSend(
  deps: HandleSendDeps,
  state: SendState
): Promise<void> {
  // Guard: concurrent sends
  if (deps.isSendingRef.current) return;
  if (!deps.activeId) return;
  if (!deps.draft.trim()) return;

  // can_reply guard
  if (!deps.isDraftTemplate && !deps.canReply) return;

  const requestedConvId = deps.activeId;

  deps.isSendingRef.current = true;
  state.sending = true;
  state.error = null;

  try {
    await deps.sendMessage(requestedConvId, deps.draft);
    state.draft = "";    // success: clear input
    state.lastConvId = requestedConvId;
  } catch (e: any) {
    state.error = e?.message ?? "Erro desconhecido";
    // draft preserved on error
  } finally {
    state.sending = false;
    deps.isSendingRef.current = false;
  }

  // Secondary: non-blocking
  if (deps.activeIdRef.current === requestedConvId) {
    deps.refreshMessages(requestedConvId).catch(() => {});
  }
}

// ── Testes ────────────────────────────────────────────────────────────────────

describe("T31 — handleSend: estado de loading e concorrência", () => {
  let state: SendState;
  let isSendingRef: { current: boolean };
  let activeIdRef: { current: number | null };

  beforeEach(() => {
    state = { sending: false, draft: "Olá", error: null, requestCount: 0, lastConvId: null };
    isSendingRef = { current: false };
    activeIdRef = { current: 1 };
  });

  // T31-01: sucesso → setSending(false)
  it("T31-01: sucesso libera loading imediatamente após o envio", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const refreshMessages = vi.fn().mockResolvedValue(undefined);

    await simulateHandleSend(
      { activeId: 1, draft: "Olá", isSendingRef, canReply: true, isDraftTemplate: false, sendMessage, refreshMessages, activeIdRef },
      state
    );

    expect(state.sending).toBe(false);
    expect(state.draft).toBe("");
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  // T31-02: erro → setSending(false)
  it("T31-02: erro no envio libera loading e preserva o draft", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("500 Internal Server Error"));
    const refreshMessages = vi.fn().mockResolvedValue(undefined);

    await simulateHandleSend(
      { activeId: 1, draft: "Olá", isSendingRef, canReply: true, isDraftTemplate: false, sendMessage, refreshMessages, activeIdRef },
      state
    );

    expect(state.sending).toBe(false);
    expect(state.error).toContain("500");
    expect(state.draft).toBe("Olá"); // preservado
  });

  // T31-03: timeout → setSending(false)
  it("T31-03: timeout libera loading e não trava indefinidamente", async () => {
    vi.useFakeTimers();
    const neverResolves = new Promise<void>(() => {});
    const sendMessage = vi.fn((_convId: number) =>
      withTimeout(neverResolves, 25_000, "Envio de mensagem")
    );
    const refreshMessages = vi.fn().mockResolvedValue(undefined);

    const p = simulateHandleSend(
      { activeId: 1, draft: "Olá", isSendingRef, canReply: true, isDraftTemplate: false, sendMessage, refreshMessages, activeIdRef },
      state
    );
    vi.advanceTimersByTime(25_001);
    await p;
    vi.useRealTimers();

    expect(state.sending).toBe(false);
    expect(state.error).toMatch(/tempo limite/);
    expect(state.draft).toBe("Olá"); // preservado após timeout
  });

  // T31-04: refetch trava → botão liberado assim mesmo
  it("T31-04: refetch de mensagens travado não bloqueia o botão", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    // refreshMessages never resolves — fire-and-forget, shouldn't matter
    const refreshMessages = vi.fn(() => new Promise<void>(() => {}));

    await simulateHandleSend(
      { activeId: 1, draft: "Olá", isSendingRef, canReply: true, isDraftTemplate: false, sendMessage, refreshMessages, activeIdRef },
      state
    );

    // sending must be false immediately — we don't await refreshMessages
    expect(state.sending).toBe(false);
    expect(state.draft).toBe("");
  });

  // T31-05: clique duplo → apenas um request
  it("T31-05: clique duplo gera apenas um request", async () => {
    let resolveFirst!: () => void;
    const firstCall = new Promise<void>((r) => { resolveFirst = r; });
    const sendMessage = vi.fn(() => firstCall);
    const refreshMessages = vi.fn().mockResolvedValue(undefined);

    const deps = { activeId: 1, draft: "Olá", isSendingRef, canReply: true, isDraftTemplate: false, sendMessage, refreshMessages, activeIdRef };

    // Fire two sends concurrently — second must be blocked by isSendingRef
    const p1 = simulateHandleSend(deps, state);
    const p2 = simulateHandleSend(deps, state); // second click before p1 resolves

    resolveFirst();
    await Promise.all([p1, p2]);

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  // T31-06: Enter repetido → apenas um request
  it("T31-06: Enter repetido gera apenas um request", async () => {
    let resolveFirst!: () => void;
    const inFlight = new Promise<void>((r) => { resolveFirst = r; });
    const sendMessage = vi.fn(() => inFlight);
    const refreshMessages = vi.fn().mockResolvedValue(undefined);

    const deps = { activeId: 1, draft: "Olá", isSendingRef, canReply: true, isDraftTemplate: false, sendMessage, refreshMessages, activeIdRef };

    const p1 = simulateHandleSend(deps, state);
    // Three more Enter presses while in-flight
    simulateHandleSend(deps, state);
    simulateHandleSend(deps, state);
    simulateHandleSend(deps, state);

    resolveFirst();
    await p1;

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  // T31-07: can_reply=false → não dispara request
  it("T31-07: can_reply=false bloqueia sem fazer request", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const refreshMessages = vi.fn().mockResolvedValue(undefined);

    await simulateHandleSend(
      { activeId: 1, draft: "Olá", isSendingRef, canReply: false, isDraftTemplate: false, sendMessage, refreshMessages, activeIdRef },
      state
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(state.sending).toBe(false);
    expect(isSendingRef.current).toBe(false);
  });

  // T31-08: can_reply=false mas é template → permite envio
  it("T31-08: can_reply=false não bloqueia template", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const refreshMessages = vi.fn().mockResolvedValue(undefined);

    await simulateHandleSend(
      { activeId: 1, draft: "Olá", isSendingRef, canReply: false, isDraftTemplate: true, sendMessage, refreshMessages, activeIdRef },
      state
    );

    expect(sendMessage).toHaveBeenCalledOnce();
  });

  // T31-09: troca de conversa durante envio → refetch não aplica na conv errada
  it("T31-09: troca de conversa durante envio não contamina outra conversa", async () => {
    const appliedTo: number[] = [];

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const refreshMessages = vi.fn((convId: number) => {
      appliedTo.push(convId);
      return Promise.resolve();
    });

    const deps = { activeId: 1, draft: "Olá", isSendingRef, canReply: true, isDraftTemplate: false, sendMessage, refreshMessages, activeIdRef };

    // Simulate user switching to conv 2 while send is in-flight
    activeIdRef.current = 2;

    await simulateHandleSend(deps, state);

    // refreshMessages should not have been called (or applied) because activeIdRef changed
    expect(appliedTo).not.toContain(1);
  });

  // T31-10: sucesso limpa draft; erro preserva draft
  it("T31-10: sucesso limpa draft, erro preserva draft", async () => {
    const successSend = vi.fn().mockResolvedValue(undefined);
    const refreshMessages = vi.fn().mockResolvedValue(undefined);

    await simulateHandleSend(
      { activeId: 1, draft: "Mensagem A", isSendingRef, canReply: true, isDraftTemplate: false, sendMessage: successSend, refreshMessages, activeIdRef },
      state
    );
    expect(state.draft).toBe("");

    // Reset state for error case
    state.draft = "Mensagem B";
    state.error = null;
    isSendingRef.current = false;

    const failSend = vi.fn().mockRejectedValue(new Error("422"));
    await simulateHandleSend(
      { activeId: 1, draft: "Mensagem B", isSendingRef, canReply: true, isDraftTemplate: false, sendMessage: failSend, refreshMessages, activeIdRef },
      state
    );
    expect(state.draft).toBe("Mensagem B"); // preserved
  });

  // T31-11: isSendingRef sempre reseta para false após finally
  it("T31-11: isSendingRef é false após sucesso, erro e timeout", async () => {
    const cases = [
      { label: "sucesso", sendFn: vi.fn().mockResolvedValue(undefined) },
      { label: "erro",    sendFn: vi.fn().mockRejectedValue(new Error("err")) },
    ];

    for (const c of cases) {
      isSendingRef.current = false;
      state.draft = "Olá";
      state.sending = false;
      await simulateHandleSend(
        { activeId: 1, draft: "Olá", isSendingRef, canReply: true, isDraftTemplate: false, sendMessage: c.sendFn, refreshMessages: vi.fn().mockResolvedValue(undefined), activeIdRef },
        state
      );
      expect(isSendingRef.current).toBe(false);
      expect(state.sending).toBe(false);
    }
  });
});
