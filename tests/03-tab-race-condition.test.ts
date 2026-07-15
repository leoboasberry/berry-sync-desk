/**
 * T03 — Race condition no carregamento por tab
 *
 * Bug alvo: src/routes/index.tsx — loop async de paginação
 *
 * Cenário: usuário troca de tab enquanto página 2 está em voo.
 * O `cancelled` boolean previne setState depois do cleanup,
 * MAS não aborta o fetch em andamento. Se o teste mostrar que
 * dados de uma tab aparecem no estado de outra, o bug é confirmado.
 *
 * Este teste usa Deferred Promises para controlar a ordem das respostas.
 */

import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { newTrace, recordEvidence, printEvidenceSummary, resetEvidenceLog } from "./evidence-log";

// ── Deferred promise helper ───────────────────────────────────────────────────
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ── Simulação do loader de conversations (extrai lógica de index.tsx:694–830) ──
type Conv = { id: number; status: string; last_activity_at: number; _tab: string };
type PageResult = { convs: Conv[]; total: number };

/**
 * Simula a função getChatwootConversationsPage com controle externo.
 * Cada chamada retorna uma promise deferred que o teste pode resolver na ordem desejada.
 */
function createMockPageFn() {
  const calls: Array<{
    tab: string;
    page: number;
    deferred: ReturnType<typeof deferred<PageResult>>;
  }> = [];

  const fn = async (tab: string, page: number): Promise<PageResult> => {
    const d = deferred<PageResult>();
    calls.push({ tab, page, deferred: d });
    return d.promise;
  };

  return { fn, calls };
}

/**
 * Reprodução do loop de paginação de index.tsx com `cancelled` boolean.
 * Retorna o estado final de conversations e todos os setConversations calls.
 */
async function runTabLoader(
  tab: string,
  getPage: (tab: string, page: number) => Promise<PageResult>,
  cancelledRef: { current: boolean },
  onSetConversations: (convs: Conv[], fromTab: string, page: number) => void
): Promise<Conv[]> {
  const allNormalized: Conv[] = [];
  let page = 1;

  while (true) {
    if (cancelledRef.current) return allNormalized;

    const { convs } = await getPage(tab, page);

    if (cancelledRef.current) return allNormalized;

    allNormalized.push(...convs);
    onSetConversations([...allNormalized], tab, page);

    if (convs.length < 3) break; // simula página com menos de PAGE_SIZE
    page++;
  }

  return allNormalized;
}

const traceId = newTrace();
afterAll(() => printEvidenceSummary());
beforeEach(() => resetEvidenceLog());

describe("T03 — Race condition entre tabs", () => {
  it("Cenário A: tab muda durante paginação — dados da tab antiga não contaminam nova tab", async () => {
    const { fn: mockPage, calls } = createMockPageFn();

    const setCalls: Array<{ convs: Conv[]; fromTab: string; page: number }> = [];
    let conversationsState: Conv[] = [];

    const cancelledOpen = { current: false };

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T03-tab-race", step: "Iniciando loader de tab=open",
      status: "INFO",
    });

    // Inicia loader para "open"
    const openLoaderPromise = runTabLoader("open", mockPage, cancelledOpen, (convs, tab, page) => {
      setCalls.push({ convs, fromTab: tab, page });
      conversationsState = convs;
    });

    // Aguarda página 1 de "open" ser solicitada
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(1);
    expect(calls[0].tab).toBe("open");
    expect(calls[0].page).toBe(1);

    // Resolve página 1 de "open" com 3 itens (simula PAGE_SIZE=3, haverá página 2)
    calls[0].deferred.resolve({
      convs: [
        { id: 101, status: "open", last_activity_at: 1000, _tab: "open" },
        { id: 102, status: "open", last_activity_at: 999,  _tab: "open" },
        { id: 103, status: "open", last_activity_at: 998,  _tab: "open" },
      ],
      total: 6,
    });

    // Aguarda página 2 de "open" ser solicitada
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(2);

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T03-tab-race", step: "Página 1 de 'open' resolvida, página 2 em voo. Usuário troca para 'pending'.",
      status: "INFO",
      stateBefore: "tab=open, página 2 pendente",
    });

    // USUÁRIO TROCA DE TAB — cancela loader de "open"
    cancelledOpen.current = true;

    // Inicia loader para "pending"
    const cancelledPending = { current: false };
    const pendingLoaderPromise = runTabLoader("pending", mockPage, cancelledPending, (convs, tab, page) => {
      setCalls.push({ convs, fromTab: tab, page });
      conversationsState = convs;
    });

    await new Promise((r) => setTimeout(r, 0));
    // Página 1 de "pending" solicitada (calls[2])
    const pendingCall = calls.find((c) => c.tab === "pending");
    expect(pendingCall).toBeDefined();

    // Resolve "pending" página 1 (última página — só 2 items)
    pendingCall!.deferred.resolve({
      convs: [
        { id: 201, status: "pending", last_activity_at: 2000, _tab: "pending" },
        { id: 202, status: "pending", last_activity_at: 1999, _tab: "pending" },
      ],
      total: 2,
    });

    await pendingLoaderPromise;

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T03-tab-race", step: "Loader de 'pending' terminou. Resolvendo página 2 de 'open' atrasada.",
      status: "INFO",
      stateAfter: `conversationsState tem ${conversationsState.length} itens`,
    });

    // AGORA resolve a página 2 de "open" (chegou depois de "pending" ter terminado)
    const openPage2Call = calls.find((c) => c.tab === "open" && c.page === 2);
    expect(openPage2Call).toBeDefined();
    openPage2Call!.deferred.resolve({
      convs: [
        { id: 104, status: "open", last_activity_at: 997, _tab: "open" },
      ],
      total: 6,
    });

    await openLoaderPromise;

    // ── ASSERTION PRINCIPAL ──────────────────────────────────────────────────
    // O cancelled=true deveria ter impedido setConversations de "open" pág 2
    const openCallsAfterCancel = setCalls.filter(
      (c) => c.fromTab === "open" && c.page >= 2
    );

    const contaminated = conversationsState.some((c) => c._tab === "open");
    const openDataLeaked = openCallsAfterCancel.length > 0;

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T03-tab-race",
      step: "Verificando contaminação do estado de 'pending' com dados de 'open'",
      status: contaminated ? "FAIL" : "PASS",
      assertion: "Estado final de conversations NÃO deve conter itens de tab='open'",
      expected: "Apenas itens _tab='pending'",
      actual: contaminated
        ? `Contaminado: ${conversationsState.filter((c) => c._tab === "open").map((c) => c.id).join(", ")}`
        : "Limpo",
      stateBefore: "tab=pending",
      stateAfter: conversationsState.map((c) => `id=${c.id}(_tab=${c._tab})`).join(", "),
      error: contaminated
        ? "BUG CONFIRMADO: dados de tab='open' aparecem no estado de tab='pending'"
        : undefined,
      file: "src/routes/index.tsx",
    });

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T03-tab-race",
      step: "Verificando se setCalls de 'open' após cancel foram suprimidos",
      status: openDataLeaked ? "WARNING" : "PASS",
      assertion: "Não deve haver setConversations de tab='open' após cancelled=true",
      expected: 0,
      actual: openCallsAfterCancel.length,
      error: openDataLeaked
        ? `WARNING: ${openCallsAfterCancel.length} setConversations calls de 'open' após cancelled=true. Estado correto mas houve set call.`
        : undefined,
    });

    expect(contaminated).toBe(false);
  });

  it("Cenário B: tab cycling open→pending→resolved→open em <500ms com respostas fora de ordem", async () => {
    const results: Array<{ tab: string; finalState: Conv[] }> = [];
    const allSetCalls: Array<{ tab: string; convs: Conv[] }> = [];

    // Simula 4 mudanças de tab com respostas chegando fora de ordem
    const defs = {
      open1:    deferred<PageResult>(),
      pending1: deferred<PageResult>(),
      resolved1: deferred<PageResult>(),
      open2:    deferred<PageResult>(),
    };

    const tabs = ["open", "pending", "resolved", "open"];
    const tabDefs = [defs.open1, defs.pending1, defs.resolved1, defs.open2];

    let lastConversationsState: Conv[] = [];

    // Inicia todos os loaders sequencialmente (simula tab switching)
    const cancelRefs = tabs.map(() => ({ current: false }));

    const loaderPromises = tabs.map((tab, i) => {
      // Cancela o anterior
      if (i > 0) cancelRefs[i - 1].current = true;

      return runTabLoader(
        tab,
        async () => tabDefs[i].promise,
        cancelRefs[i],
        (convs, t) => {
          allSetCalls.push({ tab: t, convs });
          lastConversationsState = convs;
        }
      );
    });

    // Resolve na ORDEM INVERSA (pior caso)
    defs.open2.resolve({ convs: [{ id: 400, status: "open", last_activity_at: 4000, _tab: "open" }], total: 1 });
    defs.resolved1.resolve({ convs: [{ id: 300, status: "resolved", last_activity_at: 3000, _tab: "resolved" }], total: 1 });
    defs.pending1.resolve({ convs: [{ id: 200, status: "pending", last_activity_at: 2000, _tab: "pending" }], total: 1 });
    defs.open1.resolve({ convs: [{ id: 100, status: "open", last_activity_at: 1000, _tab: "open" }], total: 1 });

    await Promise.all(loaderPromises);

    // Estado final deve ser de "open" (última tab) com id=400
    const expectedFinalId = 400;
    const actualFinalIds = lastConversationsState.map((c) => c.id);
    const contaminated = lastConversationsState.some((c) => c.id !== expectedFinalId);

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T03-tab-cycling",
      step: "Estado final após open→pending→resolved→open com respostas invertidas",
      status: contaminated ? "FAIL" : "PASS",
      assertion: "Estado final deve conter apenas dados da última tab (open, id=400)",
      expected: [expectedFinalId],
      actual: actualFinalIds,
      error: contaminated
        ? `BUG CONFIRMADO: estado final contém ids=${actualFinalIds.join(",")} — tab anterior contaminou`
        : undefined,
    });

    expect(lastConversationsState.every((c) => c.id === expectedFinalId)).toBe(true);
  });
});
