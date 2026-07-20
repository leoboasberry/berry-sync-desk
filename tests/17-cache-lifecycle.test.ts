/**
 * T1–T15 (Etapa 2) — BroadcastChannel, Web Locks e lifecycle do cache
 *
 * Numeração local neste arquivo: teste 1 = primeiro da etapa 2.
 * A numeração global de cenários continua a partir dos testes anteriores,
 * mas os IDs de describe usam prefixo "E2-T" para evitar colisão.
 *
 * Todos os testes são comportamentais e rodam em Node.js com:
 * - fake-indexeddb injetado globalmente (para o lease fallback via IndexedDB)
 * - BroadcastChannel mockado via vi.stubGlobal
 * - navigator.locks mockado onde necessário, ausente onde não
 *
 * Regras preservadas:
 * - Nenhum banco é apagado
 * - clearScopedDb nunca é chamado
 * - Os 5 RED anteriores permanecem intocados
 */

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { newTrace, recordEvidence, printEvidenceSummary } from "./evidence-log";

import {
  createCacheLifecycle,
  isValidEnvelope,
  readLease,
  renewLease,
  LEASE_TTL_MS,
  LEASE_RENEWAL_INTERVAL_MS,
  type BroadcastEnvelope,
  type BroadcastPayload,
  type CacheLifecycle,
} from "@/lib/cache-lifecycle";
import { closeDb } from "@/lib/db";

const traceId = newTrace();
afterEach(() => printEvidenceSummary());

// ── MockBroadcastChannel ──────────────────────────────────────────────────────
// Simula o comportamento real: rota mensagens para todas as instâncias do mesmo
// canal, exceto o remetente. Deve ser resetado entre testes.

class MockBroadcastChannel {
  static _channels: Map<string, Set<MockBroadcastChannel>> = new Map();

  name: string;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  _closed = false;

  constructor(name: string) {
    this.name = name;
    if (!MockBroadcastChannel._channels.has(name)) {
      MockBroadcastChannel._channels.set(name, new Set());
    }
    MockBroadcastChannel._channels.get(name)!.add(this);
  }

  postMessage(data: unknown): void {
    if (this._closed) return;
    const subs = MockBroadcastChannel._channels.get(this.name) ?? new Set();
    for (const ch of subs) {
      if (ch !== this && !ch._closed && ch.onmessage) {
        ch.onmessage({ data });
      }
    }
  }

  close(): void {
    this._closed = true;
    MockBroadcastChannel._channels.get(this.name)?.delete(this);
  }

  static reset(): void {
    MockBroadcastChannel._channels.clear();
  }
}

// ── Mock Web Locks ─────────────────────────────────────────────────────────────

class MockLockManager {
  _held = new Set<string>();

  async request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: { name: string } | null) => Promise<void>
  ): Promise<void> {
    if (options.signal?.aborted) {
      const err = new DOMException("Aborted", "AbortError");
      throw err;
    }

    if (options.ifAvailable && this._held.has(name)) {
      await callback(null);
      return;
    }

    this._held.add(name);
    try {
      await callback({ name });
    } finally {
      this._held.delete(name);
    }
  }

  reset(): void {
    this._held.clear();
  }
}

// ── Contadores para scopes únicos ─────────────────────────────────────────────

let _counter = 0;
function freshParams(overrides: Partial<{ env: string; userId: string; accountId: number }> = {}) {
  _counter++;
  return {
    env: "development" as const,
    userId: `user-${_counter}`,
    accountId: 1,
    handlers: {},
    ...overrides,
  };
}

// ── Setup/teardown ────────────────────────────────────────────────────────────

let openLifecycles: CacheLifecycle[] = [];

function track(lc: CacheLifecycle): CacheLifecycle {
  openLifecycles.push(lc);
  return lc;
}

beforeEach(() => {
  MockBroadcastChannel.reset();
  vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
  // Navigator sem locks por padrão — forçar fallback de lease
  vi.stubGlobal("navigator", undefined);
});

afterEach(() => {
  openLifecycles.forEach((lc) => lc.close());
  openLifecycles = [];
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-T1 — User A não recebe broadcast de User B
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-T1 — User A não recebe broadcast de User B", () => {
  it("BroadcastChannel de B está em canal diferente; A não recebe LOGOUT de B", () => {
    const receivedByA: string[] = [];
    const lcA = track(createCacheLifecycle({
      env: "development",
      userId: "user-A",
      accountId: 1,
      handlers: { onLogout: () => receivedByA.push("logout") },
    }));

    const lcB = track(createCacheLifecycle({
      env: "development",
      userId: "user-B",
      accountId: 1,
      handlers: {},
    }));

    lcB.broadcast({ type: "LOGOUT" });
    expect(receivedByA).toHaveLength(0); // A não ouve o canal de B

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-T1", step: "User A não recebeu LOGOUT de User B", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-T2 — Staging não recebe evento de production
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-T2 — Staging não recebe evento de production", () => {
  it("canal inclui env no nome; production e staging são canais distintos", () => {
    const receivedByStaging: string[] = [];
    const lcProd = track(createCacheLifecycle({
      env: "production",
      userId: "user-X",
      accountId: 1,
      handlers: {},
    }));

    const lcStaging = track(createCacheLifecycle({
      env: "staging",
      userId: "user-X",
      accountId: 1,
      handlers: { onLogout: () => receivedByStaging.push("logout") },
    }));

    expect(lcProd.channelName).toBe("berry-sync:production:user-X");
    expect(lcStaging.channelName).toBe("berry-sync:staging:user-X");

    lcProd.broadcast({ type: "LOGOUT" });
    expect(receivedByStaging).toHaveLength(0);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-T2", step: "Staging não recebeu evento de production (canais distintos)", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-T3 — Aba não processa o próprio evento
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-T3 — Aba não processa o próprio evento", () => {
  it("isValidEnvelope descarta envelope quando tabId == ownTabId", () => {
    const lc = track(createCacheLifecycle(freshParams({ userId: "user-self" })));
    const envelope: BroadcastEnvelope<BroadcastPayload> = {
      version: 1,
      env: "development",
      userId: "user-self",
      tabId: lc.tabId,       // mesmo tabId
      timestamp: Date.now(),
      payload: { type: "LOGOUT" },
    };
    expect(isValidEnvelope(envelope, "development", "user-self", lc.tabId)).toBe(false);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-T3", step: "isValidEnvelope=false quando tabId == ownTabId", status: "PASS" });
  });

  it("handler não dispara quando aba tenta processar seu próprio broadcast", () => {
    const fired: string[] = [];
    const lc = track(createCacheLifecycle({
      env: "development",
      userId: "user-self2",
      accountId: 1,
      handlers: { onLogout: () => fired.push("logout") },
    }));
    // broadcast emite para outras instâncias no mesmo canal, não para si mesmo
    lc.broadcast({ type: "LOGOUT" });
    expect(fired).toHaveLength(0);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-T3-handler", step: "Handler não disparado pelo próprio broadcast", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-T4 — Duas abas do mesmo usuário recebem CACHE_UPDATED
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-T4 — Duas abas do mesmo usuário recebem CACHE_UPDATED", () => {
  it("aba B e aba C recebem CACHE_UPDATED emitido por aba A", () => {
    const receivedB: string[] = [];
    const receivedC: string[] = [];

    const lcA = track(createCacheLifecycle({
      env: "development", userId: "user-multi", accountId: 1, handlers: {},
    }));
    const lcB = track(createCacheLifecycle({
      env: "development", userId: "user-multi", accountId: 1,
      handlers: { onCacheUpdated: ({ status }) => receivedB.push(status) },
    }));
    const lcC = track(createCacheLifecycle({
      env: "development", userId: "user-multi", accountId: 1,
      handlers: { onCacheUpdated: ({ status }) => receivedC.push(status) },
    }));

    lcA.broadcast({ type: "CACHE_UPDATED", status: "open" });

    expect(receivedB).toEqual(["open"]);
    expect(receivedC).toEqual(["open"]);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-T4", step: "Abas B e C receberam CACHE_UPDATED emitido por A", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-T5 — Logout de A fecha abas de A, sem afetar B
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-T5 — Logout de A fecha abas de A sem afetar B", () => {
  it("aba A2 recebe LOGOUT de A1; aba B não recebe", () => {
    const receivedA2: string[] = [];
    const receivedB: string[] = [];

    const lcA1 = track(createCacheLifecycle({
      env: "development", userId: "user-A5", accountId: 1, handlers: {},
    }));
    track(createCacheLifecycle({
      env: "development", userId: "user-A5", accountId: 1,
      handlers: { onLogout: () => receivedA2.push("logout") },
    }));
    track(createCacheLifecycle({
      env: "development", userId: "user-B5", accountId: 1,
      handlers: { onLogout: () => receivedB.push("logout") },
    }));

    lcA1.broadcast({ type: "LOGOUT" });

    expect(receivedA2).toEqual(["logout"]); // aba A2 recebe
    expect(receivedB).toHaveLength(0);       // aba B não recebe

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-T5", step: "Logout propagou para A2 mas não para User B", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-T6 — Banco não é apagado no logout remoto
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-T6 — Banco não é apagado no logout remoto", () => {
  it("onLogout fecha o lifecycle; banco pode ser reaberto com dados intactos", async () => {
    const { upsertConversations, getConversationsFromCache, onLogout: dbLogout } = await import("@/lib/db");
    const params = freshParams({ userId: "user-persist-e2t6" });

    // Inserir dados antes do logout
    await upsertConversations(params, [{ id: 1, status: "open", last_activity_at: 100 }]);

    let logoutCalled = false;
    const lc = createCacheLifecycle({
      ...params,
      handlers: {
        onLogout: () => {
          logoutCalled = true;
          dbLogout(params.env, params.userId); // fecha o handle Dexie
        },
      },
    });

    // Simular logout remoto: outro tab envia LOGOUT
    const sender = track(createCacheLifecycle({
      ...params,
      handlers: {},
    }));
    sender.broadcast({ type: "LOGOUT" });
    lc.close();

    expect(logoutCalled).toBe(true);

    // Verificar que o banco não foi apagado — dados ainda existem
    const convs = await getConversationsFromCache(params, "open");
    expect(convs).toHaveLength(1);

    closeDb(params.env, params.userId);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-T6", step: "Logout remoto: handler chamado; banco não apagado; dados recuperáveis", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-T7 — Somente uma aba consegue o lock (Web Locks)
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-T7 — Web Locks: somente uma aba consegue o lock", () => {
  it("com Web Locks mockado, segunda aba recebe null e não executa fn", async () => {
    const lockManager = new MockLockManager();
    vi.stubGlobal("navigator", { locks: lockManager });

    const params = freshParams();
    const lcA = track(createCacheLifecycle({ ...params, handlers: {} }));
    const lcB = track(createCacheLifecycle({ ...params, userId: params.userId, handlers: {} }));

    const executed: string[] = [];
    let resolveA!: () => void;
    const fnA = () => new Promise<void>((res) => { resolveA = res; executed.push("A-started"); });

    // A adquire o lock (segura sem liberar)
    const lockAPromise = lcA.runWithSyncLock("sync:open", fnA);
    // B tenta enquanto A segura → deve pular
    await lcB.runWithSyncLock("sync:open", async () => { executed.push("B-ran"); });

    resolveA!();
    await lockAPromise;

    expect(executed).toEqual(["A-started"]); // B não executou

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-T7", step: "Web Locks: B não executou enquanto A segurava o lock", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-T8 — Lock liberado após sucesso
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-T8 — Web Locks: lock liberado após sucesso", () => {
  it("após fn de A completar, B consegue adquirir o lock", async () => {
    const lockManager = new MockLockManager();
    vi.stubGlobal("navigator", { locks: lockManager });

    const params = freshParams();
    const lcA = track(createCacheLifecycle({ ...params, handlers: {} }));
    const lcB = track(createCacheLifecycle({ ...params, handlers: {} }));

    const executed: string[] = [];
    await lcA.runWithSyncLock("sync:open", async () => { executed.push("A"); });
    await lcB.runWithSyncLock("sync:open", async () => { executed.push("B"); });

    expect(executed).toEqual(["A", "B"]);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-T8", step: "B adquiriu lock após A terminar com sucesso", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-T9 — Lock liberado após erro na fn
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-T9 — Web Locks: lock liberado mesmo após erro em fn", () => {
  it("fn de A lança erro; B consegue o lock na sequência", async () => {
    const lockManager = new MockLockManager();
    vi.stubGlobal("navigator", { locks: lockManager });

    const params = freshParams();
    const lcA = track(createCacheLifecycle({ ...params, handlers: {} }));
    const lcB = track(createCacheLifecycle({ ...params, handlers: {} }));

    const executed: string[] = [];
    // A lança erro — lock deve ser liberado assim mesmo
    await lcA.runWithSyncLock("sync:open", async () => {
      executed.push("A-started");
      throw new Error("sync failed");
    });
    // B deve conseguir executar
    await lcB.runWithSyncLock("sync:open", async () => { executed.push("B"); });

    expect(executed).toEqual(["A-started", "B"]);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-T9", step: "B adquiriu lock após erro em A", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-T10 — Lock liberado após AbortSignal
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-T10 — Web Locks: AbortSignal cancela a requisição de lock", () => {
  it("signal já abortado antes de runWithSyncLock faz lançar AbortError ou pular", async () => {
    const lockManager = new MockLockManager();
    vi.stubGlobal("navigator", { locks: lockManager });

    const params = freshParams();
    const lc = track(createCacheLifecycle({ ...params, handlers: {} }));

    const executed: string[] = [];
    const ctrl = new AbortController();
    ctrl.abort(); // já abortado

    // Com o Web Locks mock, signal abortado lança AbortError
    try {
      await lc.runWithSyncLock("sync:open", async () => { executed.push("ran"); }, { signal: ctrl.signal });
    } catch (e: any) {
      expect(e.name).toBe("AbortError");
    }

    expect(executed).toHaveLength(0); // fn não executou

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-T10", step: "Signal já abortado: fn não executou; AbortError lançado", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-T11 — Lease expirado pode ser recuperado (fallback IndexedDB)
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-T11 — Lease: lease expirado pode ser recuperado por outra aba", () => {
  it("lease com expiresAt no passado é ignorado; nova aba consegue o lock", async () => {
    // Navigator sem locks → usa lease fallback
    const params = freshParams({ userId: "user-lease-t11" });
    const lcA = track(createCacheLifecycle({ ...params, handlers: {} }));
    const lcB = track(createCacheLifecycle({ ...params, handlers: {} }));

    // Inserir lease expirado manualmente
    const { getDb } = await import("@/lib/db");
    const db = getDb(params.env, params.userId);
    await db.meta.put({
      accountId: params.accountId,
      key: "sync_lease:sync:open",
      value: {
        ownerTabId: "dead-tab",
        acquiredAt: Date.now() - 60_000,
        expiresAt: Date.now() - 1,  // já expirou
      },
    });

    const executed: string[] = [];
    let leaseOwnerDuringExec: string | undefined;

    await lcB.runWithSyncLock("sync:open", async () => {
      executed.push("B");
      // verificar lease enquanto B o possui (antes de ser liberado)
      const lease = await readLease(params.env, params.userId, params.accountId, "sync:open");
      leaseOwnerDuringExec = lease?.ownerTabId;
    });

    expect(executed).toEqual(["B"]);                    // B executou
    expect(leaseOwnerDuringExec).toBe(lcB.tabId);       // lease pertencia a B durante exec

    // Após runWithSyncLock completar, o lease é liberado
    const leaseAfter = await readLease(params.env, params.userId, params.accountId, "sync:open");
    expect(leaseAfter).toBeNull();                       // liberado corretamente

    closeDb(params.env, params.userId);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-T11", step: "Lease expirado recuperado pela aba B", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-T12 — Lease válido não pode ser roubado
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-T12 — Lease: lease válido não pode ser roubado por outra aba", () => {
  it("lease com expiresAt no futuro mantém B bloqueado", async () => {
    const params = freshParams({ userId: "user-lease-t12" });
    const lcB = track(createCacheLifecycle({ ...params, handlers: {} }));

    // Inserir lease válido de outra aba
    const { getDb } = await import("@/lib/db");
    const db = getDb(params.env, params.userId);
    await db.meta.put({
      accountId: params.accountId,
      key: "sync_lease:sync:open",
      value: {
        ownerTabId: "another-tab",
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 30_000,  // válido por 30s
      },
    });

    const executed: string[] = [];
    await lcB.runWithSyncLock("sync:open", async () => { executed.push("B"); });
    expect(executed).toHaveLength(0); // B não conseguiu o lease

    closeDb(params.env, params.userId);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-T12", step: "Lease válido de outra aba bloqueou B corretamente", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-T13 — Evento malformado é descartado
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-T13 — Evento malformado é descartado silenciosamente", () => {
  const cases: [string, unknown][] = [
    ["null",                 null],
    ["string",               "invalid"],
    ["version errada",       { version: 2, env: "development", userId: "u", tabId: "t", timestamp: 1, payload: { type: "LOGOUT" } }],
    ["env errado",           { version: 1, env: "production",  userId: "u", tabId: "t", timestamp: 1, payload: { type: "LOGOUT" } }],
    ["userId errado",        { version: 1, env: "development", userId: "other", tabId: "t", timestamp: 1, payload: { type: "LOGOUT" } }],
    ["sem timestamp",        { version: 1, env: "development", userId: "u", tabId: "t", payload: { type: "LOGOUT" } }],
    ["payload sem type",     { version: 1, env: "development", userId: "u", tabId: "t", timestamp: 1, payload: {} }],
    ["payload não-objeto",   { version: 1, env: "development", userId: "u", tabId: "t", timestamp: 1, payload: "string" }],
  ];

  for (const [label, data] of cases) {
    it(`descarta: ${label}`, () => {
      expect(isValidEnvelope(data, "development", "u", "other-tab")).toBe(false);
    });
  }

  it("aceita envelope válido de outra aba", () => {
    const valid: BroadcastEnvelope<BroadcastPayload> = {
      version: 1,
      env: "development",
      userId: "u",
      tabId: "other-tab",
      timestamp: Date.now(),
      payload: { type: "LOGOUT" },
    };
    expect(isValidEnvelope(valid, "development", "u", "my-tab")).toBe(true);
  });

  it("handler não dispara para envelope malformado recebido pelo canal", () => {
    const fired: string[] = [];
    const lc = track(createCacheLifecycle({
      env: "development", userId: "user-malformed", accountId: 1,
      handlers: { onLogout: () => fired.push("logout") },
    }));

    // Enviar mensagem malformada diretamente para o canal (via instância interna)
    const ch = MockBroadcastChannel._channels.get(lc.channelName);
    ch?.forEach((instance) => {
      if (!instance._closed && instance.onmessage) {
        instance.onmessage({ data: { version: 99, garbage: true } }); // inválido
      }
    });

    expect(fired).toHaveLength(0);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-T13", step: "Envelope malformado ignorado; handler não disparado", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-T14 — Listener não permanece ativo após close()
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-T14 — Listener não permanece ativo após close()", () => {
  it("após lc.close(), handler não dispara para mensagens posteriores", () => {
    const fired: string[] = [];
    const sender = track(createCacheLifecycle({
      env: "development", userId: "user-close", accountId: 1, handlers: {},
    }));
    const receiver = createCacheLifecycle({ // não entra em track — fechamos manualmente
      env: "development", userId: "user-close", accountId: 1,
      handlers: { onCacheUpdated: () => fired.push("cache-updated") },
    });

    // Verificar que funciona antes de close()
    sender.broadcast({ type: "CACHE_UPDATED", status: "open" });
    expect(fired).toEqual(["cache-updated"]);

    // Fechar receiver
    receiver.close();
    fired.length = 0;

    // Emitir novamente — receiver não deve responder
    sender.broadcast({ type: "CACHE_UPDATED", status: "pending" });
    expect(fired).toHaveLength(0);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-T14", step: "Listener não ativo após close(); zero handlers disparados", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-T15 — Mudança de accountId encerra o lifecycle anterior
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-T15 — Mudança de accountId encerra o lifecycle anterior", () => {
  it("ao trocar conta, close() no lifecycle antigo impede handlers de disparar", () => {
    const firedOld: string[] = [];
    const firedNew: string[] = [];

    const lcOld = createCacheLifecycle({
      env: "development", userId: "user-switch", accountId: 1,
      handlers: { onCacheUpdated: () => firedOld.push("old") },
    });
    const sender = track(createCacheLifecycle({
      env: "development", userId: "user-switch", accountId: 1, handlers: {},
    }));

    // Simular troca de conta: fechar lifecycle da conta 1
    lcOld.close();

    const lcNew = track(createCacheLifecycle({
      env: "development", userId: "user-switch", accountId: 2,
      handlers: { onCacheUpdated: () => firedNew.push("new") },
    }));

    sender.broadcast({ type: "CACHE_UPDATED", status: "open" }, 1);

    expect(firedOld).toHaveLength(0); // lifecycle antigo fechado → não dispara
    expect(firedNew).toHaveLength(0); // novo lifecycle é da conta 2 → accountId não bate

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-T15",
      step: "Troca de accountId: lifecycle antigo fechado não dispara; novo tem accountId diferente",
      status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-R1 — renewLease por owner estende expiresAt
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-R1 — renewLease estende expiresAt quando owner é o mesmo", () => {
  it("expiresAt é incrementado e ownerTabId não muda", async () => {
    const params = freshParams();
    const tabId = "owner-E2R1";
    const now = Date.now();
    const { getDb } = await import("@/lib/db");
    const db = getDb(params.env, params.userId);
    await db.meta.put({
      accountId: params.accountId,
      key: "sync_lease:r1",
      value: { ownerTabId: tabId, acquiredAt: now, expiresAt: now + LEASE_TTL_MS },
    });

    // Small real delay so that the renewed expiresAt is strictly greater
    await new Promise((r) => setTimeout(r, 20));

    const ok = await renewLease(params.env, params.userId, params.accountId, "r1", tabId);
    const lease = await readLease(params.env, params.userId, params.accountId, "r1");

    expect(ok).toBe(true);
    expect(lease!.ownerTabId).toBe(tabId);
    expect(lease!.expiresAt).toBeGreaterThan(now + LEASE_TTL_MS);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-R1", step: "renewLease estendeu expiresAt mantendo ownerTabId", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-R2 — Outra aba não assume lease durante período de renovação ativa
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-R2 — Lease válido bloqueia nova aquisição enquanto owner renova", () => {
  it("Tab B não executa fn enquanto Tab A segura lease válido", async () => {
    const params = freshParams();
    const lcA = track(createCacheLifecycle({ ...params, handlers: {} }));
    const lcB = track(createCacheLifecycle({ ...params, handlers: {} }));

    // A keeps the lease alive by acquiring it
    let resolveA!: () => void;
    const aPromise = lcA.runWithSyncLock("r2-key", async () => {
      await new Promise<void>((r) => { resolveA = r; });
    });

    // Give A time to acquire
    await new Promise((r) => setTimeout(r, 50));

    const executedB: boolean[] = [];
    const bPromise = lcB.runWithSyncLock("r2-key", async () => {
      executedB.push(true);
    });

    // B should NOT have executed yet — A still holds the lock
    await new Promise((r) => setTimeout(r, 30));
    expect(executedB).toHaveLength(0);

    resolveA();
    await Promise.all([aPromise, bPromise]);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-R2", step: "Tab B bloqueada enquanto Tab A segurava lease válido", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-R3 — Lease liberado e outra aba pode adquirir após fn de sucesso
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-R3 — Lease liberado após fn completar com sucesso (finally executado)", () => {
  it("lease é nulo após sucesso; outra aba consegue o lock em seguida", async () => {
    const params = freshParams();
    const lcA = track(createCacheLifecycle({ ...params, handlers: {} }));
    const lcB = track(createCacheLifecycle({ ...params, handlers: {} }));

    await lcA.runWithSyncLock("r3-key", async () => { /* success */ });

    // Lease must be gone
    const leaseAfter = await readLease(params.env, params.userId, params.accountId, "r3-key");
    expect(leaseAfter).toBeNull();

    // B must be able to acquire the lock
    const executed: string[] = [];
    await lcB.runWithSyncLock("r3-key", async () => { executed.push("B"); });
    expect(executed).toContain("B");

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-R3", step: "lease nulo após sucesso; Tab B conseguiu lock em seguida", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-R4 — Lease liberado mesmo após erro na fn (finally sempre executado)
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-R4 — Lease liberado após erro na fn", () => {
  it("lease é nulo após fn lançar erro; outra aba consegue o lock", async () => {
    const params = freshParams();
    const lcA = track(createCacheLifecycle({ ...params, handlers: {} }));
    const lcB = track(createCacheLifecycle({ ...params, handlers: {} }));

    await lcA.runWithSyncLock("r4-key", async () => {
      throw new Error("simulated failure");
    });

    const leaseAfter = await readLease(params.env, params.userId, params.accountId, "r4-key");
    expect(leaseAfter).toBeNull();

    const executed: string[] = [];
    await lcB.runWithSyncLock("r4-key", async () => { executed.push("B"); });
    expect(executed).toContain("B");

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-R4", step: "lease nulo após erro; Tab B conseguiu lock", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-R5 — Lease liberado após abort (finally sempre executado)
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-R5 — Lease liberado após AbortSignal ser acionado", () => {
  it("lease é nulo após abort; outra aba consegue o lock", async () => {
    const params = freshParams();
    const ctrl = new AbortController();
    const lcA = track(createCacheLifecycle({ ...params, handlers: {} }));
    const lcB = track(createCacheLifecycle({ ...params, handlers: {} }));

    await lcA.runWithSyncLock("r5-key", async () => {
      ctrl.abort(); // abort mid-execution
    }, { signal: ctrl.signal });

    const leaseAfter = await readLease(params.env, params.userId, params.accountId, "r5-key");
    expect(leaseAfter).toBeNull();

    const executed: string[] = [];
    await lcB.runWithSyncLock("r5-key", async () => { executed.push("B"); });
    expect(executed).toContain("B");

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-R5", step: "lease nulo após abort; Tab B conseguiu lock", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-R6 — Aba morta (sem renovação) deixa lease expirar; outra assume
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-R6 — Lease com expiresAt no passado é recuperado por outra aba", () => {
  it("Tab B adquire lock quando lease de Tab A já está expirado (sem renovação)", async () => {
    const params = freshParams();
    const deadTabId = "dead-tab-r6";
    const { getDb } = await import("@/lib/db");
    const db = getDb(params.env, params.userId);

    // Simulate dead tab: lease already expired
    await db.meta.put({
      accountId: params.accountId,
      key: "sync_lease:r6-key",
      value: {
        ownerTabId: deadTabId,
        acquiredAt: Date.now() - LEASE_TTL_MS - 5_000,
        expiresAt: Date.now() - 1_000, // in the past
      },
    });

    const lcB = track(createCacheLifecycle({ ...params, handlers: {} }));
    const executed: string[] = [];

    await lcB.runWithSyncLock("r6-key", async () => {
      executed.push("B");
    });

    expect(executed).toContain("B");

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-R6", step: "Tab B assumiu lease de aba morta (expirado)", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2-R7 — renewLease com tabId incorreto retorna false
// ─────────────────────────────────────────────────────────────────────────────
describe("E2-R7 — renewLease com tabId incorreto retorna false", () => {
  it("impostor não rova o lease ao tentar renovar com tabId errado", async () => {
    const params = freshParams();
    const realOwner = "tab-real-owner";
    const impostor = "tab-impostor";
    const { getDb } = await import("@/lib/db");
    const db = getDb(params.env, params.userId);
    const now = Date.now();

    await db.meta.put({
      accountId: params.accountId,
      key: "sync_lease:r7-key",
      value: { ownerTabId: realOwner, acquiredAt: now, expiresAt: now + LEASE_TTL_MS },
    });

    const result = await renewLease(params.env, params.userId, params.accountId, "r7-key", impostor);

    expect(result).toBe(false);

    const lease = await readLease(params.env, params.userId, params.accountId, "r7-key");
    expect(lease!.ownerTabId).toBe(realOwner);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "E2-R7", step: "impostor não renovou — lease permanece com o owner real", status: "PASS" });
  });
});
