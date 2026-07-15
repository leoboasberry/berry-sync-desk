/**
 * T06 — activeIdRef.current usado após await
 *
 * Bug alvo: index.tsx:463–485
 *
 * Padrão perigoso identificado:
 *   const conversationId = activeIdRef.current;   // captura ANTES do await
 *   const result = await getChatwootMessages(...); // await — activeId pode ter mudado
 *   usar(activeIdRef.current);                     // usa valor NOVO — pode ser diferente!
 *
 * Se o usuário trocar de conversa durante o await:
 *   - result contém mensagens de conversa A
 *   - activeIdRef.current agora aponta para conversa B
 *   - setMessages(result.msgs) popula a view de B com dados de A
 */

import { describe, it, expect, afterAll } from "vitest";
import { newTrace, recordEvidence, printEvidenceSummary } from "./evidence-log";

const traceId = newTrace();
afterAll(() => printEvidenceSummary());

// ── Simulação do padrão bugado ────────────────────────────────────────────────
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

type Message = { id: number; conversation_id: number; content: string };

describe("T06 — activeIdRef.current stale após await", () => {
  it("Cenário A: mensagens de conversa A renderizadas em conversa B", async () => {
    // Estado inicial: usuário está na conversa 111
    const activeIdRef = { current: 111 };
    let renderedMessages: Message[] = [];
    let conversationIdRendered: number | null = null;

    // Mock: getChatwootMessages com delay controlado
    const fetchDef = deferred<{ msgs: Message[]; can_reply: boolean }>();
    const mockGetMessages = async (conversationId: number) => {
      // PADRÃO BUGADO: não captura activeId antes do await
      // Usa activeIdRef.current DEPOIS do await
      return fetchDef.promise;
    };

    // Inicia fetch para conversa 111 (comportamento de index.tsx:464)
    const fetchPromise = mockGetMessages(activeIdRef.current).then((result) => {
      // AQUI está o bug: activeIdRef.current pode ter mudado durante o await
      // index.tsx:485: c.id === activeIdRef.current ? { ...c, can_reply: ... }
      conversationIdRendered = activeIdRef.current; // usa ref ATUAL (pode ser diferente!)
      renderedMessages = result.msgs;

      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T06-stale-ref",
        step: "Mensagens retornadas — activeId no momento do uso",
        status: "INFO",
        conversationIdRequested: 111,
        conversationIdReturned: result.msgs[0]?.conversation_id,
        conversationIdActive: activeIdRef.current,
        conversationIdRendered: activeIdRef.current,
      });
    });

    // DURANTE o await, usuário troca para conversa 222
    activeIdRef.current = 222;

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T06-stale-ref",
      step: "Usuário trocou para conversa 222 enquanto fetch de 111 estava em voo",
      status: "INFO",
      conversationIdRequested: 111,
      conversationIdActive: activeIdRef.current,
    });

    // Resolve o fetch com dados da conversa 111
    fetchDef.resolve({
      msgs: [
        { id: 1, conversation_id: 111, content: "Mensagem de conversa 111" },
        { id: 2, conversation_id: 111, content: "Outra mensagem de 111" },
      ],
      can_reply: true,
    });

    await fetchPromise;

    // ── ASSERTIONS ──────────────────────────────────────────────────────────
    const mismatch =
      renderedMessages.length > 0 &&
      renderedMessages[0].conversation_id !== conversationIdRendered;

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T06-stale-ref",
      step: "Verificar se mensagens de 111 foram renderizadas em 222",
      status: mismatch ? "FAIL" : "PASS",
      assertion: "renderedConversationId deve ser == conversation_id das mensagens",
      expected: 111,
      actual: conversationIdRendered,
      conversationIdRequested: 111,
      conversationIdReturned: renderedMessages[0]?.conversation_id,
      conversationIdActive: 222,
      conversationIdRendered: conversationIdRendered ?? undefined,
      error: mismatch
        ? `BUG CONFIRMADO: mensagens de conversa_id=111 renderizadas quando activeId=222`
        : undefined,
      file: "src/routes/index.tsx",
      line: 464,
    });

    // O bug: conversationIdRendered é 222 (activeIdRef.current no momento do .then)
    // mas as mensagens são de 111
    expect(conversationIdRendered).toBe(111); // RED TEST — vai ser 222
  });

  it("Cenário B: padrão correto — capturar ID antes do await", async () => {
    const activeIdRef = { current: 111 };
    let renderedMessages: Message[] = [];
    let conversationIdRendered: number | null = null;

    const fetchDef = deferred<{ msgs: Message[]; can_reply: boolean }>();

    const fetchPromise = (async () => {
      // PADRÃO CORRETO: captura ANTES do await
      const requestedId = activeIdRef.current;

      const result = await fetchDef.promise;

      // Valida que activeId não mudou durante o await
      if (activeIdRef.current !== requestedId) {
        recordEvidence({
          traceId, timestamp: new Date().toISOString(),
          scenario: "T06-correct-pattern",
          step: "activeId mudou durante await — descartando resultado",
          status: "PASS",
          conversationIdRequested: requestedId,
          conversationIdActive: activeIdRef.current,
        });
        return; // DESCARTA o resultado — não atualiza o estado
      }

      conversationIdRendered = requestedId;
      renderedMessages = result.msgs;
    })();

    // Troca de conversa durante o await
    activeIdRef.current = 222;

    fetchDef.resolve({
      msgs: [
        { id: 1, conversation_id: 111, content: "Mensagem de 111" },
      ],
      can_reply: true,
    });

    await fetchPromise;

    const correct = renderedMessages.length === 0; // descartou corretamente

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T06-correct-pattern",
      step: "Padrão correto: resultado descartado quando activeId mudou",
      status: correct ? "PASS" : "FAIL",
      expected: "renderedMessages vazio (resultado descartado)",
      actual: renderedMessages.length === 0 ? "vazio" : `${renderedMessages.length} mensagens de 111 renderizadas`,
    });

    expect(renderedMessages.length).toBe(0);
    expect(conversationIdRendered).toBeNull();
  });

  it("Mapeamento: todos os usos de activeIdRef.current após await em index.tsx", () => {
    // Análise estática dos usos identificados
    const riskyPatterns = [
      {
        line: 464,
        code: "getChatwootMessages({ data: { conversationId: activeIdRef.current } })",
        issue: "conversationId capturado de activeIdRef no momento da chamada — OK",
        risk: "BAIXO — o ID é passado corretamente como parâmetro",
      },
      {
        line: 485,
        code: "c.id === activeIdRef.current ? { ...c, can_reply: result.can_reply } : c",
        issue: "activeIdRef.current usado DENTRO do .then() — pode ter mudado durante await",
        risk: "ALTO — can_reply de conversa A aplicado na conversa B",
      },
      {
        line: 471,
        code: "setMessages(newMsgs) — sem validar que activeId ainda é o mesmo",
        issue: "setMessages atualiza o estado sem verificar se a conversa ainda está ativa",
        risk: "ALTO — mensagens de A aparecem na view de B",
      },
    ];

    for (const pattern of riskyPatterns) {
      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T06-static-analysis",
        step: `Linha ${pattern.line}: ${pattern.risk}`,
        status: pattern.risk === "ALTO" ? "FAIL" : "WARNING",
        assertion: pattern.issue,
        actual: pattern.code,
        file: "src/routes/index.tsx",
        line: pattern.line,
        error: pattern.risk === "ALTO" ? pattern.issue : undefined,
      });
    }

    const highRiskCount = riskyPatterns.filter((p) => p.risk === "ALTO").length;
    expect(highRiskCount).toBe(0); // RED TEST — documenta 2 usos de alto risco
  });
});
