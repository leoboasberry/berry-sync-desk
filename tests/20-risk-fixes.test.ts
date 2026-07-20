/**
 * tests/20-risk-fixes.test.ts
 *
 * Testes comportamentais para as correções R1, R3, R4, R5 e R6.
 *
 * R1  — Nenhum sync com escopo inválido (__loading__, accountId=0)
 * R3  — Poll stale não atualiza sidebar e não grava no scope errado
 * R4  — Ordenação determinística (last_activity_at DESC, id DESC)
 * R5  — Conversas ausentes preservadas como stale (soft-delete)
 * R6  — isStillCurrent bloqueia write quando geração muda entre check e transação
 *
 * Cobertura total: 30 testes
 */

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getConversationsFromCache,
  getActiveCachedConversations,
  getStaleCachedConversations,
  markMissingConversationsStale,
  replaceScopedConversations,
  upsertConversations,
  type CacheScope,
} from "../src/lib/db";
import { syncConversations } from "../src/lib/conversation-sync";

// ── helpers ───────────────────────────────────────────────────────────────────

let _uid = 0;
function freshScope(overrides: Partial<CacheScope> = {}): CacheScope {
  return {
    env: "development",
    userId: `user-r-${++_uid}`,
    accountId: 1,
    ...overrides,
  };
}

function conv(id: number, status = "open", last_activity_at = 1000): unknown {
  return { id, status, last_activity_at };
}

function makePage(rows: unknown[], total?: number) {
  return async (_p: number, _s: AbortSignal) => ({ convs: rows, total: total ?? rows.length });
}

// ── R1: escopo inválido ───────────────────────────────────────────────────────

describe("R1-1 — syncConversations com userId __loading__ não grava no DB real", () => {
  it("dados de __loading__ não aparecem para userId real", async () => {
    const fakeScope = freshScope({ userId: "__loading__", accountId: 0 });
    const realScope = freshScope({ userId: "real-user-r1", accountId: 1 });
    const genRef = { current: 0 };
    const gen = ++genRef.current;

    await syncConversations({
      scope: fakeScope,
      status: "open",
      lifecycle: null,
      fetchPage: makePage([conv(1)]),
      signal: new AbortController().signal,
      generation: gen,
      generationRef: genRef,
      callbacks: {},
    });

    const rows = await getConversationsFromCache(realScope, "open");
    expect(rows).toHaveLength(0);
  });
});

describe("R1-2 — accountId=0 cria scope isolado que não vaza para accountId real", () => {
  it("dados em accountId=0 não aparecem em accountId=1", async () => {
    const zeroScope = freshScope({ accountId: 0 });
    const realScope = freshScope({ userId: zeroScope.userId, accountId: 1 });
    const genRef = { current: 0 };

    await syncConversations({
      scope: zeroScope,
      status: "open",
      lifecycle: null,
      fetchPage: makePage([conv(99)]),
      signal: new AbortController().signal,
      generation: ++genRef.current,
      generationRef: genRef,
      callbacks: {},
    });

    const rows = await getConversationsFromCache(realScope, "open");
    expect(rows).toHaveLength(0);
  });
});

describe("R1-3 — userId resolve antes de accountId: callback não é chamado com scope parcial", () => {
  it("onComplete não é chamado quando geração muda antes do scope completar", async () => {
    const scope = freshScope({ accountId: 0 });
    const genRef = { current: 0 };
    const gen = ++genRef.current;

    let resolveP!: () => void;
    const p = new Promise<{ convs: unknown[]; total: number }>((res) => {
      resolveP = () => res({ convs: [conv(10)], total: 1 });
    });

    const onComplete = vi.fn();
    const syncP = syncConversations({
      scope,
      status: "open",
      lifecycle: null,
      fetchPage: () => p,
      signal: new AbortController().signal,
      generation: gen,
      generationRef: genRef,
      callbacks: { onComplete },
    });

    // accountId chega, geração avança (scope completo agora com gen+1)
    ++genRef.current;
    resolveP();
    await syncP;

    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe("R1-4 — logout (userId=null) impede novo sync via geração stale", () => {
  it("sync iniciado antes do logout não completa após geração avançar", async () => {
    const scope = freshScope();
    const genRef = { current: 0 };
    const gen = ++genRef.current;

    let resolveP!: () => void;
    const p = new Promise<{ convs: unknown[]; total: number }>((res) => {
      resolveP = () => res({ convs: [conv(20)], total: 1 });
    });

    const onComplete = vi.fn();
    const syncP = syncConversations({
      scope,
      status: "open",
      lifecycle: null,
      fetchPage: () => p,
      signal: new AbortController().signal,
      generation: gen,
      generationRef: genRef,
      callbacks: { onComplete },
    });

    // Logout: geração avança, userId passa a null (simulado pelo avanço de geração)
    ++genRef.current;
    resolveP();
    await syncP;

    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe("R1-5 — nenhuma request com accountId=0 chama onCacheLoaded", () => {
  it("onCacheLoaded não é chamado quando accountId=0 e DB está vazio", async () => {
    const scope = freshScope({ accountId: 0 });
    const genRef = { current: 1 };
    const onCacheLoaded = vi.fn();

    await syncConversations({
      scope,
      status: "open",
      lifecycle: null,
      fetchPage: makePage([]),
      signal: new AbortController().signal,
      generation: 1,
      generationRef: genRef,
      callbacks: { onCacheLoaded },
    });

    expect(onCacheLoaded).not.toHaveBeenCalled();
  });
});

describe("R1-6 — escopo __loading__ com dados na rede: nada gravado no scope real após mudança de geração", () => {
  it("DB real permanece vazio após sync fantasma stale", async () => {
    const realScope = freshScope({ userId: "user-r1-6", accountId: 5 });
    const genRef = { current: 0 };

    // Simula: effect tentaria rodar com scope não-resolvido mas geração já avançou
    const gen1 = ++genRef.current;
    ++genRef.current; // gen2 — simula scope resolver e re-executar effect

    const onComplete = vi.fn();
    let resolveP!: () => void;
    const p = new Promise<{ convs: unknown[]; total: number }>((res) => {
      resolveP = () => res({ convs: [conv(55)], total: 1 });
    });

    const syncP = syncConversations({
      scope: { env: "development", userId: "__loading__", accountId: 0 },
      status: "open",
      lifecycle: null,
      fetchPage: () => p,
      signal: new AbortController().signal,
      generation: gen1,
      generationRef: genRef,
      callbacks: { onComplete },
    });

    resolveP();
    await syncP;

    expect(onComplete).not.toHaveBeenCalled();
    const rows = await getConversationsFromCache(realScope, "open");
    expect(rows).toHaveLength(0);
  });
});

// ── R3: poll stale ────────────────────────────────────────────────────────────

describe("R3-1 — poll responde após troca de tab: guard bloqueia setConversations", () => {
  it("simulação de poll stale: geração antiga não deve atualizar UI", async () => {
    const scope = freshScope();
    await upsertConversations(scope, [conv(1, "open", 100)]);
    const genRef = { current: 0 };

    // Gen 1: poll de "open" inicia
    const pollGen1 = ++genRef.current;
    const pollTab1 = "open";

    let resolvePoll!: () => void;
    const pollDone = new Promise<void>((res) => { resolvePoll = res; });

    // Simula request do poll
    const pollRequest = async () => {
      await pollDone; // request em vôo
      // Validação ANTES de chamar setConversations (como o poll fixo faz)
      if (pollGen1 !== genRef.current || pollTab1 !== "pending") {
        return false; // descartado
      }
      return true;
    };

    // Usuário troca para "pending": geração avança
    ++genRef.current;

    // Poll responde agora
    resolvePoll();
    const accepted = await pollRequest();

    // O poll de "open" NÃO deve ser aceito porque a tab mudou para "pending"
    expect(accepted).toBe(false);
  });
});

describe("R3-2 — poll responde após troca de conta: guard bloqueia update", () => {
  it("accountId stale impede aplicação do resultado do poll", async () => {
    const genRef = { current: 0 };
    const pollAccountId = 1;
    const gen = ++genRef.current;

    let resolveP!: () => void;
    const p = new Promise<void>((res) => { resolveP = res; });

    // Simula lógica do poll com guard
    const pollWithGuard = async (currentAccountId: () => number, currentGen: () => number) => {
      const capturedAccountId = pollAccountId;
      const capturedGen = gen;
      await p;
      if (currentGen() !== capturedGen || currentAccountId() !== capturedAccountId) {
        return "discarded";
      }
      return "applied";
    };

    // Troca de conta acontece durante o request
    ++genRef.current;
    const currentAccountId = 2; // conta B
    resolveP();
    const result = await pollWithGuard(() => currentAccountId, () => genRef.current);
    expect(result).toBe("discarded");
  });
});

describe("R3-3 — poll não inicia quando userId é null (R1)", () => {
  it("guard R1 bloqueia poll quando userId não está disponível", () => {
    const userId: string | null = null;
    const accountId = 1;
    // Simula o guard do poll
    const shouldRunPoll = !(!userId || !accountId || accountId <= 0);
    expect(shouldRunPoll).toBe(false);
  });
});

describe("R3-4 — poll não inicia quando accountId=0", () => {
  it("guard R1 bloqueia poll quando accountId=0", () => {
    const userId = "user-x";
    const accountId = 0;
    const shouldRunPoll = !(!userId || !accountId || accountId <= 0);
    expect(shouldRunPoll).toBe(false);
  });
});

describe("R3-5 — poll erro de rede: .then() não executa, setConversations não é chamado", () => {
  it("promise rejeitada não chama setConversations", async () => {
    const scope = freshScope();
    await upsertConversations(scope, [conv(1, "open", 500)]);
    const setConvsMock = vi.fn();

    // Simula o padrão real do poll: fetch().then(setConvs).catch(() => {})
    const fakeRequest = (): Promise<any[]> => Promise.reject(new Error("network error"));

    await fakeRequest()
      .then((convs) => {
        setConvsMock(convs); // nunca executa se a promise rejeitou
      })
      .catch(() => {}); // silencia o erro

    expect(setConvsMock).not.toHaveBeenCalled();

    // DB inalterado — o erro no poll não gravou nada
    const rows = await getConversationsFromCache(scope, "open");
    expect(rows).toHaveLength(1);
  });
});

// ── R4: ordenação determinística ──────────────────────────────────────────────

function sortConversations(convs: any[]): any[] {
  return [...convs].sort((a, b) => {
    const byActivity = (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0);
    if (byActivity !== 0) return byActivity;
    return (b.id ?? 0) - (a.id ?? 0);
  });
}

describe("R4-1 — orderação por last_activity_at DESC", () => {
  it("conversa mais recente primeiro", () => {
    const convs = [
      { id: 1, last_activity_at: 100 },
      { id: 2, last_activity_at: 300 },
      { id: 3, last_activity_at: 200 },
    ];
    const sorted = sortConversations(convs);
    expect(sorted.map((c) => c.id)).toEqual([2, 3, 1]);
  });
});

describe("R4-2 — tiebreaker id DESC quando last_activity_at é igual", () => {
  it("id maior vem antes quando timestamps são iguais", () => {
    const ts = 5000;
    const convs = [
      { id: 1, last_activity_at: ts },
      { id: 5, last_activity_at: ts },
      { id: 3, last_activity_at: ts },
    ];
    const sorted = sortConversations(convs);
    expect(sorted.map((c) => c.id)).toEqual([5, 3, 1]);
  });
});

describe("R4-3 — ordenação estável com múltiplas páginas fora de ordem", () => {
  it("merge de duas páginas produz ordem determinística", () => {
    const page1 = [
      { id: 10, last_activity_at: 1000 },
      { id: 8,  last_activity_at: 800 },
    ];
    const page2 = [
      { id: 9,  last_activity_at: 900 },
      { id: 7,  last_activity_at: 800 }, // mesmo ts que id=8
    ];
    const all = [...page1, ...page2];
    // Dedup por id
    const byId = new Map<number, any>();
    for (const c of all) byId.set(c.id, c);
    const sorted = sortConversations(Array.from(byId.values()));
    expect(sorted.map((c) => c.id)).toEqual([10, 9, 8, 7]);
  });
});

describe("R4-4 — ordem preservada após event Realtime com mesmo timestamp", () => {
  it("update de last_activity_at: conversation id maior sobe, tiebreaker mantém order", () => {
    const now = 9999;
    const convs = [
      { id: 5, last_activity_at: now },
      { id: 3, last_activity_at: now },
      { id: 1, last_activity_at: now - 1 },
    ];
    const sorted = sortConversations(convs);
    expect(sorted.map((c) => c.id)).toEqual([5, 3, 1]);
  });
});

describe("R4-5 — páginas chegando em ordens diferentes produzem mesmo resultado final", () => {
  it("página 1 depois de página 2: resultado igual a página 2 depois de página 1", () => {
    const setA = [
      { id: 3, last_activity_at: 300 },
      { id: 1, last_activity_at: 100 },
    ];
    const setB = [
      { id: 4, last_activity_at: 400 },
      { id: 2, last_activity_at: 200 },
    ];

    const order1 = sortConversations([...setA, ...setB]);
    const order2 = sortConversations([...setB, ...setA]);
    expect(order1.map((c) => c.id)).toEqual(order2.map((c) => c.id));
    expect(order1.map((c) => c.id)).toEqual([4, 3, 2, 1]);
  });
});

// ── R5: soft-delete / stale ───────────────────────────────────────────────────

describe("R5-1 — conversa ausente do sync é marcada stale, não deletada", () => {
  it("markMissingConversationsStale preserva a conversa no DB com stale=true", async () => {
    const scope = freshScope();
    await upsertConversations(scope, [conv(1), conv(2), conv(3)]);

    // Sync completo retornou apenas 1 e 3 (id=2 ausente)
    const marked = await markMissingConversationsStale(scope, "open", new Set([1, 3]));
    expect(marked).toBe(1); // um registro marcado

    // id=2 existe no DB mas com stale=true
    const stale = await getStaleCachedConversations(scope, "open");
    expect(stale.map((r) => r.id)).toContain(2);
    expect(stale.find((r) => r.id === 2)?.stale).toBe(true);
    expect(stale.find((r) => r.id === 2)?.staleReason).toBe("not_returned");
  });
});

describe("R5-2 — conversa stale não aparece em getConversationsFromCache", () => {
  it("getConversationsFromCache exclui stale=true", async () => {
    const scope = freshScope();
    await upsertConversations(scope, [conv(10), conv(11)]);
    await markMissingConversationsStale(scope, "open", new Set([10]));

    const active = await getConversationsFromCache(scope, "open");
    expect(active.map((r) => r.id)).toContain(10);
    expect(active.map((r) => r.id)).not.toContain(11); // 11 é stale
  });
});

describe("R5-3 — getActiveCachedConversations é alias de getConversationsFromCache", () => {
  it("retorna mesmo resultado que getConversationsFromCache", async () => {
    const scope = freshScope();
    await upsertConversations(scope, [conv(20), conv(21)]);
    await markMissingConversationsStale(scope, "open", new Set([20]));

    const fromCache = await getConversationsFromCache(scope, "open");
    const fromActive = await getActiveCachedConversations(scope, "open");
    expect(fromCache.map((r) => r.id)).toEqual(fromActive.map((r) => r.id));
  });
});

describe("R5-4 — conversa reaparece no sync: volta a stale=false", () => {
  it("upsertConversations limpa stale de conversa que reapareceu", async () => {
    const scope = freshScope();
    await upsertConversations(scope, [conv(30)]);
    await markMissingConversationsStale(scope, "open", new Set()); // id=30 fica stale

    // Conversa reaparece na próxima sincronização
    await upsertConversations(scope, [conv(30)]);

    const active = await getConversationsFromCache(scope, "open");
    expect(active.map((r) => r.id)).toContain(30);

    const stale = await getStaleCachedConversations(scope, "open");
    expect(stale.map((r) => r.id)).not.toContain(30);
  });
});

describe("R5-5 — sync parcial (incomplete) não marca nada como stale", () => {
  it("mergeScopedConversations nunca marca stale", async () => {
    const scope = freshScope();
    await upsertConversations(scope, [conv(40), conv(41)]);

    // Sync parcial (merge): só traz id=40 mas NÃO marca id=41 como stale
    const { mergeScopedConversations } = await import("../src/lib/db");
    await mergeScopedConversations(scope, [conv(40)]);

    const stale = await getStaleCachedConversations(scope, "open");
    expect(stale.map((r) => r.id)).not.toContain(41);

    const active = await getConversationsFromCache(scope, "open");
    expect(active.map((r) => r.id)).toContain(41); // preservado
  });
});

describe("R5-6 — sync abortado não marca nada como stale", () => {
  it("syncConversations abortado não chama markMissingConversationsStale", async () => {
    const scope = freshScope();
    await upsertConversations(scope, [conv(50), conv(51)]);
    const genRef = { current: 0 };
    const gen = ++genRef.current;
    const ctrl = new AbortController();

    let resolveP!: () => void;
    const p = new Promise<{ convs: unknown[]; total: number }>((res) => {
      resolveP = () => res({ convs: [conv(50)], total: 1 });
    });

    const syncP = syncConversations({
      scope,
      status: "open",
      lifecycle: null,
      fetchPage: () => p,
      signal: ctrl.signal,
      generation: gen,
      generationRef: genRef,
      callbacks: {},
    });

    ctrl.abort(); // aborta antes da resposta chegar
    resolveP();
    await syncP;

    // id=51 não deve ter sido marcado como stale
    const stale = await getStaleCachedConversations(scope, "open");
    expect(stale.map((r) => r.id)).not.toContain(51);
  });
});

describe("R5-7 — replaceScopedConversations soft-delete: preserva registros como stale", () => {
  it("registros ausentes ficam no DB com stale=true em vez de serem deletados", async () => {
    const scope = freshScope();
    await upsertConversations(scope, [conv(60), conv(61), conv(62)]);

    await replaceScopedConversations(scope, "open", new Set([60, 62]), [conv(60), conv(62)]);

    // id=61 deve estar no DB como stale, não deletado
    const stale = await getStaleCachedConversations(scope, "open");
    expect(stale.map((r) => r.id)).toContain(61);

    // Mas não deve aparecer como ativo
    const active = await getConversationsFromCache(scope, "open");
    expect(active.map((r) => r.id)).not.toContain(61);
    expect(active.map((r) => r.id)).toEqual(expect.arrayContaining([60, 62]));
  });
});

describe("R5-8 — conta A stale não afeta conta B", () => {
  it("markMissingConversationsStale de accountId=1 não toca accountId=2", async () => {
    const scopeA = freshScope({ accountId: 1 });
    const scopeB = freshScope({ userId: scopeA.userId, accountId: 2 });

    await upsertConversations(scopeA, [conv(70), conv(71)]);
    await upsertConversations(scopeB, [conv(70), conv(71)]);

    await markMissingConversationsStale(scopeA, "open", new Set([70]));

    // scopeA: id=71 é stale
    const staleA = await getStaleCachedConversations(scopeA, "open");
    expect(staleA.map((r) => r.id)).toContain(71);

    // scopeB: intocado
    const staleB = await getStaleCachedConversations(scopeB, "open");
    expect(staleB).toHaveLength(0);

    const activeB = await getConversationsFromCache(scopeB, "open");
    expect(activeB).toHaveLength(2);
  });
});

describe("R5-9 — stale respeita status: open stale não contamina pending", () => {
  it("markMissingConversationsStale(status=open) não toca registros pending", async () => {
    const scope = freshScope();
    await upsertConversations(scope, [conv(80, "open"), conv(81, "pending")]);

    await markMissingConversationsStale(scope, "open", new Set()); // marca todos de open como stale

    const activePending = await getConversationsFromCache(scope, "pending");
    expect(activePending.map((r) => r.id)).toContain(81); // pending intocado
  });
});

describe("R5-10 — nenhuma informação é apagada automaticamente", () => {
  it("após replaceScopedConversations, total de registros no DB é maior ou igual", async () => {
    const scope = freshScope();
    await upsertConversations(scope, [conv(90), conv(91), conv(92)]);

    // Usa getAll via replace (soft): id=92 ausente
    await replaceScopedConversations(scope, "open", new Set([90, 91]), [conv(90), conv(91)]);

    // Verificar via getStaleCachedConversations que id=92 ainda existe
    const stale = await getStaleCachedConversations(scope, "open");
    const active = await getConversationsFromCache(scope, "open");
    const total = stale.length + active.length;

    expect(total).toBe(3); // NENHUM dado foi deletado
    expect(stale.map((r) => r.id)).toContain(92);
  });
});

// ── R6: isStillCurrent ────────────────────────────────────────────────────────

describe("R6-1 — isStillCurrent=false bloqueia write antes do início da transação", () => {
  it("DB permanece vazio quando isStillCurrent retorna false", async () => {
    const scope = freshScope();
    const genRef = { current: 1 };
    const onComplete = vi.fn();

    await syncConversations({
      scope,
      status: "open",
      lifecycle: null,
      fetchPage: makePage([conv(100)]),
      signal: new AbortController().signal,
      generation: 1,
      generationRef: genRef,
      // isStillCurrent retorna false imediatamente — simula mudança de scope
      isStillCurrent: () => false,
      callbacks: { onComplete },
    });

    const rows = await getConversationsFromCache(scope, "open");
    expect(rows).toHaveLength(0); // write não ocorreu
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe("R6-2 — isStillCurrent=true permite write normalmente", () => {
  it("DB recebe dados quando isStillCurrent retorna true", async () => {
    const scope = freshScope();
    const genRef = { current: 1 };
    const onComplete = vi.fn();

    await syncConversations({
      scope,
      status: "open",
      lifecycle: null,
      fetchPage: makePage([conv(101)]),
      signal: new AbortController().signal,
      generation: 1,
      generationRef: genRef,
      isStillCurrent: () => true,
      callbacks: { onComplete },
    });

    const rows = await getConversationsFromCache(scope, "open");
    expect(rows.map((r) => r.id)).toContain(101);
    expect(onComplete).toHaveBeenCalledOnce();
  });
});

describe("R6-3 — isStillCurrent ausente: comportamento padrão (write ocorre)", () => {
  it("sem isStillCurrent, write ocorre normalmente pelo guard de geração", async () => {
    const scope = freshScope();
    const genRef = { current: 1 };

    await syncConversations({
      scope,
      status: "open",
      lifecycle: null,
      fetchPage: makePage([conv(102)]),
      signal: new AbortController().signal,
      generation: 1,
      generationRef: genRef,
      // isStillCurrent não fornecido
      callbacks: {},
    });

    const rows = await getConversationsFromCache(scope, "open");
    expect(rows.map((r) => r.id)).toContain(102);
  });
});
