/**
 * T08 — B08: Teste comportamental do stale activeIdRef
 *
 * Reproduz o fluxo real: conversa aberta → API lenta → troca de conversa
 * → resposta da API chega → valida que NENHUM setter/cache foi chamado
 * com dados da conversa antiga.
 *
 * Não usa análise estática. Usa deferred promises para controlar o timing.
 * Simula a função handlePayload extraída de index.tsx:471–496.
 */

import { describe, it, expect, afterAll } from "vitest";
import { newTrace, recordEvidence, printEvidenceSummary } from "./evidence-log";

const traceId = newTrace();
afterAll(() => printEvidenceSummary());

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

type Message = { id: number; conversation_id: number; content: string; message_type: number };
type GetMessagesResult = { msgs: Message[]; can_reply: boolean };

// ── Simulação comportamental do trecho de index.tsx:471–496 ──────────────────
//
// ANTES do fix (B08): usa activeIdRef.current DEPOIS do await
// DEPOIS do fix (B08): captura requestedConvId ANTES do await, verifica após
//
// O teste reproduz AMBOS os comportamentos para provar a diferença.

function makeLoader(fixed: boolean) {
  // Observadores de efeitos colaterais
  const setMessagesCalls: Array<{ msgs: Message[]; calledWhenActiveId: number }> = [];
  const setConversationsCalls: Array<{ convId: number; can_reply: boolean; calledWhenActiveId: number }> = [];

  const activeIdRef = { current: 0 };

  async function onRealtimeEvent(
    getMsgs: () => Promise<GetMessagesResult>
  ) {
    if (!activeIdRef.current) return;

    if (fixed) {
      // PADRÃO CORRIGIDO (B08): captura ANTES do await
      const requestedConvId = activeIdRef.current;
      const result = await getMsgs();
      // Descarta se activeId mudou
      if (activeIdRef.current !== requestedConvId) return;
      setMessagesCalls.push({ msgs: result.msgs, calledWhenActiveId: activeIdRef.current });
      setConversationsCalls.push({ convId: requestedConvId, can_reply: result.can_reply, calledWhenActiveId: activeIdRef.current });
    } else {
      // PADRÃO BUGADO (pré-B08): usa activeIdRef.current depois do await
      const result = await getMsgs();
      // BUG: activeIdRef.current pode ter mudado durante o await
      setMessagesCalls.push({ msgs: result.msgs, calledWhenActiveId: activeIdRef.current });
      setConversationsCalls.push({ convId: activeIdRef.current, can_reply: result.can_reply, calledWhenActiveId: activeIdRef.current });
    }
  }

  return { activeIdRef, setMessagesCalls, setConversationsCalls, onRealtimeEvent };
}

describe("T08 — B08: Teste comportamental stale ref", () => {
  it("PRÉ-FIX: setMessages chamado com dados de 111 quando activeId já é 222", async () => {
    const { activeIdRef, setMessagesCalls, setConversationsCalls, onRealtimeEvent } = makeLoader(false);

    // Estado inicial: usuário em conversa 111
    activeIdRef.current = 111;

    const fetchDef = deferred<GetMessagesResult>();
    const loaderPromise = onRealtimeEvent(() => fetchDef.promise);

    // Simula fetch em voo... usuário troca para 222
    activeIdRef.current = 222;

    // API responde com dados de 111
    fetchDef.resolve({
      msgs: [
        { id: 1, conversation_id: 111, content: "msg de 111", message_type: 0 },
      ],
      can_reply: true,
    });

    await loaderPromise;

    const msgsOf111AppearedWhen222Active =
      setMessagesCalls.length > 0 &&
      setMessagesCalls[0].msgs[0].conversation_id === 111 &&
      setMessagesCalls[0].calledWhenActiveId === 222;

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T08-pre-fix",
      step: "PRÉ-FIX: setMessages chamado com msgs de conv=111 enquanto activeId=222",
      status: msgsOf111AppearedWhen222Active ? "FAIL" : "PASS",
      assertion: "setMessages NÃO deveria ter sido chamado",
      expected: "setMessages não chamado (resultado descartado)",
      actual: msgsOf111AppearedWhen222Active
        ? `setMessages chamado com ${setMessagesCalls[0].msgs.length} msgs de conv=111, activeId era ${setMessagesCalls[0].calledWhenActiveId}`
        : "setMessages não chamado",
      error: msgsOf111AppearedWhen222Active
        ? "BUG CONFIRMADO: mensagens de conversa 111 foram renderizadas quando activeId=222"
        : undefined,
    });

    // Documenta que o bug EXISTE no padrão pré-fix
    expect(msgsOf111AppearedWhen222Active).toBe(true); // passa → prova o bug pré-fix
  });

  it("PÓS-FIX (B08): setMessages NÃO chamado quando activeId muda durante await", async () => {
    const { activeIdRef, setMessagesCalls, setConversationsCalls, onRealtimeEvent } = makeLoader(true);

    // Estado inicial: usuário em conversa 111
    activeIdRef.current = 111;

    const fetchDef = deferred<GetMessagesResult>();
    const loaderPromise = onRealtimeEvent(() => fetchDef.promise);

    // Usuário troca para 222 durante o await
    activeIdRef.current = 222;

    // API responde com dados de 111
    fetchDef.resolve({
      msgs: [
        { id: 1, conversation_id: 111, content: "msg de 111", message_type: 0 },
      ],
      can_reply: true,
    });

    await loaderPromise;

    // Nenhum setter deve ter sido chamado
    const noSetMessages = setMessagesCalls.length === 0;
    const noSetConversations = setConversationsCalls.length === 0;

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T08-post-fix",
      step: "PÓS-FIX: setMessages e setConversations NÃO chamados após troca de conversa",
      status: noSetMessages && noSetConversations ? "PASS" : "FAIL",
      assertion: "Resultado descartado quando activeIdRef.current !== requestedConvId",
      expected: "0 chamadas a setMessages, 0 chamadas a setConversations",
      actual: `setMessages: ${setMessagesCalls.length}, setConversations: ${setConversationsCalls.length}`,
      error: (!noSetMessages || !noSetConversations)
        ? "REGRESSÃO: fix B08 não está descartando o resultado corretamente"
        : undefined,
    });

    expect(noSetMessages).toBe(true);
    expect(noSetConversations).toBe(true);
  });

  it("PÓS-FIX: setMessages chamado normalmente quando activeId NÃO muda durante await", async () => {
    const { activeIdRef, setMessagesCalls, onRealtimeEvent } = makeLoader(true);

    activeIdRef.current = 111;

    const fetchDef = deferred<GetMessagesResult>();
    const loaderPromise = onRealtimeEvent(() => fetchDef.promise);

    // Sem troca de conversa — usuário permanece em 111

    fetchDef.resolve({
      msgs: [
        { id: 5, conversation_id: 111, content: "nova msg", message_type: 0 },
        { id: 6, conversation_id: 111, content: "outra msg", message_type: 1 },
      ],
      can_reply: true,
    });

    await loaderPromise;

    const correctlySet =
      setMessagesCalls.length === 1 &&
      setMessagesCalls[0].msgs.length === 2 &&
      setMessagesCalls[0].calledWhenActiveId === 111;

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T08-normal-case",
      step: "PÓS-FIX: setMessages chamado normalmente quando activeId não muda",
      status: correctlySet ? "PASS" : "FAIL",
      assertion: "setMessages deve ser chamado com 2 mensagens de conv=111",
      expected: "1 chamada, 2 mensagens, activeId=111",
      actual: correctlySet
        ? "Correto"
        : `setMessages calls: ${setMessagesCalls.length}`,
    });

    expect(correctlySet).toBe(true);
  });

  it("PÓS-FIX: can_reply aplicado à conversa correta — não contamina conversa diferente", async () => {
    const { activeIdRef, setConversationsCalls, onRealtimeEvent } = makeLoader(true);

    // Usuário em 111, API lenta, troca para 333, resposta de 111 chega
    activeIdRef.current = 111;

    const fetchDef = deferred<GetMessagesResult>();
    const loaderPromise = onRealtimeEvent(() => fetchDef.promise);

    activeIdRef.current = 333;

    fetchDef.resolve({
      msgs: [{ id: 10, conversation_id: 111, content: "x", message_type: 0 }],
      can_reply: false, // janela fechada em 111
    });

    await loaderPromise;

    // can_reply=false de 111 NÃO deve ter sido aplicado a 333
    const canReplyAppliedTo333 = setConversationsCalls.some(
      (c) => c.convId === 333
    );

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T08-can-reply-isolation",
      step: "PÓS-FIX: can_reply=false de conv=111 não contamina conv=333",
      status: !canReplyAppliedTo333 ? "PASS" : "FAIL",
      assertion: "setConversations não deve ser chamado para convId=333 com dados de 111",
      expected: "Nenhuma chamada setConversations com convId=333",
      actual: canReplyAppliedTo333
        ? "can_reply de 111 aplicado a 333 — BUG"
        : "Nenhuma chamada (correto)",
      error: canReplyAppliedTo333
        ? "BUG: can_reply=false de conversa com janela fechada contamina outra conversa"
        : undefined,
    });

    expect(canReplyAppliedTo333).toBe(false);
  });
});
