/**
 * Tests 24 — message_deleted: soft-delete no IndexedDB
 *
 * Ao receber evento message_deleted:
 *   - não apagar o registro
 *   - marcar stale=true, staleReason="deleted_remotely", deletedAt preenchido
 *   - retirar da lista ativa (getActiveMessagesFromCache filtra stale=true)
 *   - simples ausência na resposta da API NÃO marca exclusão
 */

import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import {
  upsertMessages,
  getActiveMessagesFromCache,
  markMessageStale,
  type CacheScope,
} from "@/lib/db";

let n = 0;
const S = (): CacheScope => ({
  env: "test" as any,
  userId: `del-user-${++n}-${Date.now()}`,
  accountId: 1,
});

describe("MD-1 — markMessageStale marca stale sem apagar o registro", () => {
  it("mensagem marcada como stale não aparece em getActiveMessagesFromCache", async () => {
    const scope = S();
    await upsertMessages(scope, [{ id: 1, content: "mensagem", created_at: 1 }], 10);

    await markMessageStale(scope, 10, 1, "deleted_remotely");

    const active = await getActiveMessagesFromCache(scope, 10);
    expect(active).toHaveLength(0); // filtrada por stale=true
  });

  it("outras mensagens da mesma conversa não são afetadas", async () => {
    const scope = S();
    await upsertMessages(scope, [
      { id: 1, content: "removida", created_at: 1 },
      { id: 2, content: "presente", created_at: 2 },
    ], 10);

    await markMessageStale(scope, 10, 1, "deleted_remotely");

    const active = await getActiveMessagesFromCache(scope, 10);
    expect(active).toHaveLength(1);
    expect((active[0] as any).data.content).toBe("presente");
  });
});

describe("MD-2 — Ausência na resposta da API NÃO marca stale", () => {
  it("upsertMessages com menos mensagens não apaga as ausentes", async () => {
    const scope = S();
    await upsertMessages(scope, [
      { id: 1, content: "m1", created_at: 1 },
      { id: 2, content: "m2", created_at: 2 },
      { id: 3, content: "m3", created_at: 3 },
    ], 10);

    // API retorna apenas mensagem 3 (paginação ou resposta parcial)
    await upsertMessages(scope, [
      { id: 3, content: "m3-updated", created_at: 3 },
    ], 10);

    const active = await getActiveMessagesFromCache(scope, 10);
    // Todas as 3 devem permanecer
    expect(active).toHaveLength(3);
    const ids = active.map((r: any) => r.id).sort((a: number, b: number) => a - b);
    expect(ids).toEqual([1, 2, 3]);
  });
});

describe("MD-3 — staleReason preservado", () => {
  it("markMessageStale define staleReason='deleted_remotely'", async () => {
    const scope = S();
    await upsertMessages(scope, [{ id: 5, content: "x", created_at: 1 }], 10);
    await markMessageStale(scope, 10, 5, "deleted_remotely");

    // Leitura direta via rawGet (não usa filtro active)
    const db = (await import("@/lib/db")).getDb(scope.env, scope.userId);
    const row = await db.messages.get([scope.accountId, 10, 5]);
    expect(row?.stale).toBe(true);
    expect(row?.staleReason).toBe("deleted_remotely");
    expect(typeof row?.deletedAt).toBe("number");
    expect(row?.deletedAt).toBeGreaterThan(0);
  });
});

describe("MD-4 — markMessageStale é no-op para mensagem não cacheada", () => {
  it("markMessageStale de ID inexistente não lança erro", async () => {
    const scope = S();
    // Não escreve nada no cache
    let threw = false;
    try {
      await markMessageStale(scope, 10, 999, "deleted_remotely");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

describe("MD-5 — Isolamento por conta: stale em conta 1 não afeta conta 2", () => {
  it("marcar stale em accountId=1 não afeta accountId=2", async () => {
    const s1 = S();
    const s2: CacheScope = { ...s1, accountId: 2 };

    // Mesma conversa, mesmo message ID, contas diferentes
    await upsertMessages(s1, [{ id: 1, content: "conta1", created_at: 1 }], 10);
    await upsertMessages(s2, [{ id: 1, content: "conta2", created_at: 1 }], 10);

    await markMessageStale(s1, 10, 1, "deleted_remotely");

    const active1 = await getActiveMessagesFromCache(s1, 10);
    const active2 = await getActiveMessagesFromCache(s2, 10);

    expect(active1).toHaveLength(0); // stale
    expect(active2).toHaveLength(1); // não afetada
  });
});
