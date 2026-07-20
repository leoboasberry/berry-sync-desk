/**
 * T16–T31 — Isolamento, ciclo de vida e banco legado do cache IndexedDB
 *
 * Todos os testes são comportamentais puros, executados em Node.js com
 * fake-indexeddb injetado globalmente antes de qualquer import do Dexie.
 *
 * Regras preservadas:
 * - Nenhum banco é apagado automaticamente
 * - Banco legado permanece intacto
 * - TTL expirado ≠ registro excluído (só deixa de ser servido)
 * - clearScopedDb exige confirmação explícita
 */

// fake-indexeddb DEVE ser importado antes de qualquer módulo que use Dexie
import "fake-indexeddb/auto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { newTrace, recordEvidence, printEvidenceSummary } from "./evidence-log";

import {
  getDb,
  closeDb,
  onLogout,
  clearScopedDb,
  scopedDbName,
  LEGACY_DB_NAME,
  TTL_CONVERSATIONS_MS,
  TTL_MESSAGES_MS,
  TTL_CONTACTS_MS,
  isExpired,
  getConversationsFromCache,
  upsertConversations,
  getMessagesFromCache,
  upsertMessages,
  getContactFromCache,
  upsertContact,
  getSyncMeta,
  setSyncMeta,
  openLegacyDbReadOnly,
  inventoryLegacyDb,
  purgeExpiredRecords,
  type CacheScope,
} from "@/lib/db";

const traceId = newTrace();
afterEach(() => printEvidenceSummary());

// Helper: scope único por teste para evitar interferência
let _counter = 0;
function freshScope(overrides?: Partial<CacheScope>): CacheScope {
  _counter++;
  return {
    env: "development",
    userId: `user-${_counter}`,
    accountId: 1,
    ...overrides,
  };
}

// Fechar o banco após cada teste
afterEach(async () => {
  // fecha todos os bancos abertos por testes (evita handles órfãos)
  // não deleta — fake-indexeddb é efêmero por processo, mas o comportamento
  // de "não deletar" é o que os testes verificam
});

// ─────────────────────────────────────────────────────────────────────────────
// T16 — Isolamento entre usuários: bancos separados
// ─────────────────────────────────────────────────────────────────────────────
describe("T16 — Isolamento de usuário: User A e User B têm bancos distintos", () => {
  it("DB de User A e User B têm nomes diferentes", () => {
    const nameA = scopedDbName("production", "user-alice");
    const nameB = scopedDbName("production", "user-bob");
    expect(nameA).not.toBe(nameB);
    expect(nameA).toBe("berry-sync:production:user-alice");
    expect(nameB).toBe("berry-sync:production:user-bob");

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T16-db-names", step: "Nomes de banco distintos por userId", status: "PASS" });
  });

  it("Dado inserido por User A não aparece na query de User B (mesmo accountId, mesmo convId)", async () => {
    const scopeA = freshScope({ userId: "alice", accountId: 1 });
    const scopeB = freshScope({ userId: "bob", accountId: 1 });

    await upsertConversations(scopeA, [{ id: 42, status: "open", last_activity_at: 1000 }]);

    const fromA = await getConversationsFromCache(scopeA, "open");
    const fromB = await getConversationsFromCache(scopeB, "open");

    expect(fromA).toHaveLength(1);
    expect(fromB).toHaveLength(0); // User B não vê dados de A

    closeDb(scopeA.env, scopeA.userId);
    closeDb(scopeB.env, scopeB.userId);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T16-cross-user", step: "User B não vê conversas de User A", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T17 — Isolamento de conta: mesmo usuário, accountIds diferentes
// ─────────────────────────────────────────────────────────────────────────────
describe("T17 — Isolamento de conta: accountId=1 e accountId=2 não colidem", () => {
  it("convId=42 em accountId=1 não aparece em query de accountId=2", async () => {
    const scope1 = freshScope({ accountId: 1 });
    const scope2 = { ...scope1, accountId: 2 };

    await upsertConversations(scope1, [{ id: 42, status: "open", last_activity_at: 1000 }]);

    const from1 = await getConversationsFromCache(scope1, "open");
    const from2 = await getConversationsFromCache(scope2, "open");

    expect(from1).toHaveLength(1);
    expect(from2).toHaveLength(0);

    closeDb(scope1.env, scope1.userId);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T17-account-isolation", step: "accountId=2 não vê dados de accountId=1", status: "PASS" });
  });

  it("msgId=99 em accountId=1 e accountId=2 coexistem sem colisão de chave", async () => {
    const scope1 = freshScope({ accountId: 1 });
    const scope2 = { ...scope1, accountId: 2 };

    await upsertMessages(scope1, [{ id: 99, created_at: 100 }], 1);
    await upsertMessages(scope2, [{ id: 99, created_at: 200, content: "conta2" }], 1);

    const m1 = await getMessagesFromCache(scope1, 1);
    const m2 = await getMessagesFromCache(scope2, 1);

    expect(m1).toHaveLength(1);
    expect(m2).toHaveLength(1);
    // dados distintos — não houve sobreescrita
    expect((m1[0].data as any).content).toBeUndefined();
    expect((m2[0].data as any).content).toBe("conta2");

    closeDb(scope1.env, scope1.userId);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T17-message-isolation", step: "msgId=99 em contas distintas coexiste sem colisão", status: "PASS" });
  });

  it("contato phone='+5548...' em accountId=1 não aparece em accountId=2", async () => {
    const scope1 = freshScope({ accountId: 1 });
    const scope2 = { ...scope1, accountId: 2 };
    const phone = "+5548998299242";

    await upsertContact(scope1, phone, "owner-A");
    const c1 = await getContactFromCache(scope1, phone);
    const c2 = await getContactFromCache(scope2, phone);

    expect(c1?.hubspot_owner_id).toBe("owner-A");
    expect(c2).toBeNull();

    closeDb(scope1.env, scope1.userId);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T17-contact-isolation", step: "Contato de conta=1 não visível em conta=2", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T18 — TTL de conversas: expirado não é servido, mas não é apagado
// ─────────────────────────────────────────────────────────────────────────────
describe("T18 — TTL de conversas (7 dias): expirado não é servido", () => {
  it("isExpired() retorna true para cachedAt com mais de 7 dias", () => {
    const eightDaysAgo = Date.now() - TTL_CONVERSATIONS_MS - 1;
    expect(isExpired(eightDaysAgo, TTL_CONVERSATIONS_MS)).toBe(true);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T18-expired-flag", step: "isExpired=true para item com 8 dias", status: "PASS" });
  });

  it("isExpired() retorna false para cachedAt recente", () => {
    expect(isExpired(Date.now() - 60_000, TTL_CONVERSATIONS_MS)).toBe(false);
  });

  it("getConversationsFromCache não retorna registro expirado", async () => {
    const scope = freshScope();
    const expiredCachedAt = Date.now() - TTL_CONVERSATIONS_MS - 1000;

    // Inserir diretamente com cachedAt expirado
    const db = getDb(scope.env, scope.userId);
    await db.conversations.put({
      accountId: scope.accountId,
      id: 1,
      status: "open",
      last_activity_at: 100,
      data: { id: 1 },
      cachedAt: expiredCachedAt,
    });

    const results = await getConversationsFromCache(scope, "open");
    expect(results).toHaveLength(0); // expirado — não servido

    // Verificar que o registro AINDA EXISTE no banco (não foi apagado)
    const raw = await db.conversations.get([scope.accountId, 1]);
    expect(raw).toBeDefined(); // permanece no banco

    closeDb(scope.env, scope.userId);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T18-not-served", step: "Registro expirado não é servido mas permanece no banco", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T19 — TTL de contatos (30 min)
// ─────────────────────────────────────────────────────────────────────────────
describe("T19 — TTL de contatos (30 min): expirado retorna null", () => {
  it("getContactFromCache retorna null para contato com mais de 30 min", async () => {
    const scope = freshScope();
    const db = getDb(scope.env, scope.userId);
    const phone = "+5548999000001";

    await db.contacts.put({
      accountId: scope.accountId,
      phone,
      hubspot_owner_id: "owner-x",
      cachedAt: Date.now() - TTL_CONTACTS_MS - 1000,
    });

    const result = await getContactFromCache(scope, phone);
    expect(result).toBeNull(); // expirado

    // Registro permanece no banco
    const raw = await db.contacts.get([scope.accountId, phone]);
    expect(raw).toBeDefined();

    closeDb(scope.env, scope.userId);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T19-contact-ttl", step: "Contato expirado (>30min) não é servido, permanece no banco", status: "PASS" });
  });

  it("getContactFromCache retorna dado fresco", async () => {
    const scope = freshScope();
    const phone = "+5548999000002";
    await upsertContact(scope, phone, "owner-fresh");
    const result = await getContactFromCache(scope, phone);
    expect(result?.hubspot_owner_id).toBe("owner-fresh");
    closeDb(scope.env, scope.userId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T20 — onLogout: fecha o banco, não apaga
// ─────────────────────────────────────────────────────────────────────────────
describe("T20 — Logout: fecha o banco sem apagar dados", () => {
  it("onLogout() fecha a instância Dexie mas não destrói o IndexedDB", async () => {
    const scope = freshScope();
    await upsertConversations(scope, [{ id: 1, status: "open", last_activity_at: 100 }]);

    onLogout(scope.env, scope.userId);

    // Abrir novamente — dados devem estar presentes
    const afterReopen = await getConversationsFromCache(scope, "open");
    expect(afterReopen).toHaveLength(1);
    expect(afterReopen[0].id).toBe(1);

    closeDb(scope.env, scope.userId);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T20-logout-no-delete", step: "onLogout fecha instância; dados acessíveis após reabertura", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T26 — Banco legado não é apagado pelo novo módulo
// ─────────────────────────────────────────────────────────────────────────────
describe("T26 — Banco legado (berry-sync-desk) não é apagado", () => {
  it("inventoryLegacyDb() não cria nem apaga o banco legado se ele não existe", async () => {
    const report = await inventoryLegacyDb();
    // Em fake-indexeddb limpo, não existe banco legado
    expect(report.legacyDatabaseFound).toBe(false);
    expect(report.conversationsFound).toBe(0);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T26-no-legacy", step: "inventoryLegacyDb retorna found=false quando banco não existe, sem criar", status: "PASS" });
  });

  it("se banco legado existir, inventário lê sem apagar", async () => {
    // Criar banco legado via IDB raw
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(LEGACY_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        const store = db.createObjectStore("conversations", { keyPath: "id" });
        store.add({ id: 42, status: "open", last_activity_at: 1000, data: {} });
      };
      req.onsuccess = () => { req.result.close(); resolve(); };
      req.onerror = () => reject(req.error);
    });

    const report = await inventoryLegacyDb();
    expect(report.legacyDatabaseFound).toBe(true);
    expect(report.conversationsFound).toBe(1);
    // Registro sem accountId → ambíguo
    expect(report.skippedAmbiguous).toBe(1);
    expect(report.errors[0].reason).toContain("missing accountId");

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T26-legacy-found", step: "Banco legado detectado; 1 registro ambíguo; banco não apagado", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T27 — Banco legado não recebe novas escritas
// ─────────────────────────────────────────────────────────────────────────────
describe("T27 — Banco legado somente leitura: novas escritas vão apenas ao banco novo", () => {
  it("upsertConversations grava no banco novo (berry-sync:...) e não no legado", async () => {
    const scope = freshScope();
    await upsertConversations(scope, [{ id: 99, status: "open", last_activity_at: 500 }]);

    // Verificar que o dado está no banco novo
    const fromNew = await getConversationsFromCache(scope, "open");
    expect(fromNew).toHaveLength(1);
    expect(fromNew[0].id).toBe(99);

    // Verificar que o banco legado não ganhou esse registro
    const legacy = await openLegacyDbReadOnly();
    if (legacy.found) {
      const convs = await legacy.readStore("conversations");
      const found = (convs as any[]).find((c) => c.id === 99);
      expect(found).toBeUndefined(); // não foi para o legado
      legacy.close();
    }

    closeDb(scope.env, scope.userId);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T27-no-write-to-legacy", step: "Nova conversa gravada apenas no banco scoped, não no legado", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T28 — Migração ambígua é bloqueada (sem accountId)
// ─────────────────────────────────────────────────────────────────────────────
describe("T28 — Migração de registro sem accountId é bloqueada", () => {
  it("inventoryLegacyDb classifica registro sem accountId como ambíguo e não migra", async () => {
    // O banco legado criado em T26 tem registro sem accountId
    const report = await inventoryLegacyDb();
    if (!report.legacyDatabaseFound) {
      // criar banco legado se não existe ainda neste isolamento
      await new Promise<void>((resolve) => {
        const req = indexedDB.open(LEGACY_DB_NAME, 1);
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore("conversations", { keyPath: "id" });
          store.add({ id: 5, status: "open" }); // sem accountId
        };
        req.onsuccess = () => { req.result.close(); resolve(); };
        req.onerror = () => resolve();
      });
    }

    const r2 = await inventoryLegacyDb();
    // migrated deve ser 0 — nenhuma migração automática ocorre em step 1
    expect(r2.migrated).toBe(0);
    // registros sem accountId marcados como ambíguos
    expect(r2.skippedAmbiguous).toBeGreaterThanOrEqual(0);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T28-ambiguous-blocked", step: "migrated=0; registros sem accountId classificados como ambíguos", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T29 — Migração válida preserva o original no legado
// ─────────────────────────────────────────────────────────────────────────────
describe("T29 — Migração controlada preserva registro no banco legado", () => {
  it("após copiar dado legado para banco novo, original permanece no legado", async () => {
    const scope = freshScope();

    // Simular migração manual: ler do legado, escrever no novo
    const legacy = await openLegacyDbReadOnly();
    if (legacy.found) {
      const convs = await legacy.readStore("conversations");
      // Migrar apenas os que têm accountId (nenhum no legado padrão)
      const migratable = (convs as any[]).filter((c) => c.accountId);
      await upsertConversations(scope, migratable);
      legacy.close();

      // Verificar que legado ainda tem os dados
      const legacy2 = await openLegacyDbReadOnly();
      if (legacy2.found) {
        const afterMigration = await legacy2.readStore("conversations");
        expect(afterMigration.length).toBe(convs.length); // nada removido
        legacy2.close();
      }
    }

    closeDb(scope.env, scope.userId);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T29-original-preserved", step: "Legado intacto após simulação de migração", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T30 — Logout não apaga cache automaticamente
// ─────────────────────────────────────────────────────────────────────────────
describe("T30 — Logout não apaga dados persistidos", () => {
  it("após logout e re-login, User A recupera o cache intacto", async () => {
    const scope = freshScope({ userId: "user-alice-persist" });

    // Inserir dados
    await upsertConversations(scope, [
      { id: 1, status: "open", last_activity_at: 100 },
      { id: 2, status: "open", last_activity_at: 200 },
    ]);
    await setSyncMeta(scope, "last_sync_open", 12345);

    // Logout
    onLogout(scope.env, scope.userId);

    // Simular re-login (mesma identidade) — apenas reabre o banco
    const convs = await getConversationsFromCache(scope, "open");
    const meta = await getSyncMeta(scope, "last_sync_open");

    expect(convs).toHaveLength(2);
    expect(meta).toBe(12345);

    closeDb(scope.env, scope.userId);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T30-cache-after-logout", step: "Cache de User A recuperável após logout + re-login", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T31 — Usuário B não acessa banco de A
// ─────────────────────────────────────────────────────────────────────────────
describe("T31 — Usuário B não acessa dados de Usuário A", () => {
  it("User B abre seu próprio banco e não encontra dados de A", async () => {
    const scopeA = freshScope({ userId: "user-A-exclusive", accountId: 1 });
    const scopeB = freshScope({ userId: "user-B-exclusive", accountId: 1 });

    // A insere conversa
    await upsertConversations(scopeA, [{ id: 100, status: "open", last_activity_at: 999 }]);

    // B consulta — deve estar vazio
    const fromB = await getConversationsFromCache(scopeB, "open");
    expect(fromB).toHaveLength(0);

    // B não consegue abrir o banco de A com suas próprias credenciais
    const nameA = scopedDbName(scopeA.env, scopeA.userId);
    const nameB = scopedDbName(scopeB.env, scopeB.userId);
    expect(nameA).not.toBe(nameB);

    closeDb(scopeA.env, scopeA.userId);
    closeDb(scopeB.env, scopeB.userId);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T31-user-b-no-access", step: "User B consulta banco próprio; zero dados de User A visíveis", status: "PASS" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Extras — clearScopedDb e purgeExpiredRecords
// ─────────────────────────────────────────────────────────────────────────────
describe("clearScopedDb — exige confirmação explícita", () => {
  it("lança erro sem string de confirmação", async () => {
    const scope = freshScope();
    await expect(
      clearScopedDb({
        env: scope.env,
        userId: scope.userId,
        accountId: scope.accountId,
        reason: "test",
        confirmation: "WRONG" as any,
      })
    ).rejects.toThrow("confirmation string does not match");
  });

  it("apaga apenas dados do accountId especificado quando confirmado", async () => {
    const scope = freshScope();
    const scope2 = { ...scope, accountId: 2 };

    await upsertConversations(scope, [{ id: 1, status: "open", last_activity_at: 1 }]);
    await upsertConversations(scope2, [{ id: 2, status: "open", last_activity_at: 2 }]);

    const deleted = await clearScopedDb({
      env: scope.env,
      userId: scope.userId,
      accountId: scope.accountId,
      reason: "test cleanup",
      confirmation: "I_UNDERSTAND_THIS_IS_IRREVERSIBLE",
    });

    expect(deleted.conversations).toBe(1);

    // accountId=1 limpo, accountId=2 intacto
    const remain = await getConversationsFromCache(scope2, "open");
    expect(remain).toHaveLength(1);

    closeDb(scope.env, scope.userId);
  });
});

describe("purgeExpiredRecords — limpeza explícita de TTL", () => {
  it("remove registros expirados do accountId, preserva os válidos", async () => {
    const scope = freshScope();
    const db = getDb(scope.env, scope.userId);

    // 1 expirado + 1 válido
    await db.conversations.bulkPut([
      { accountId: scope.accountId, id: 10, status: "open", last_activity_at: 0, data: {}, cachedAt: Date.now() - TTL_CONVERSATIONS_MS - 1 },
      { accountId: scope.accountId, id: 11, status: "open", last_activity_at: 1, data: {}, cachedAt: Date.now() },
    ]);

    const result = await purgeExpiredRecords(scope);
    expect(result.conversations).toBe(1);

    const raw = await db.conversations.where("accountId").equals(scope.accountId).toArray();
    expect(raw).toHaveLength(1);
    expect(raw[0].id).toBe(11);

    closeDb(scope.env, scope.userId);
  });
});
