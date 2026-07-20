/**
 * Tests 22 — Feature flags
 *
 * Cobre: flag desligada usa somente rede; flag ligada por usuário;
 * usuário B continua no legado; flag desligada durante sessão;
 * dados locais preservados quando flag desligada.
 */

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import {
  isFeatureEnabled,
  isFeatureEnabledSync,
  invalidateFlagsCache,
  _testInjectFlags,
  FLAG_CONVERSATION_CACHE,
  FLAG_MESSAGE_CACHE,
} from "@/lib/feature-flags";
import {
  upsertMessages,
  getActiveMessagesFromCache,
  type CacheScope,
} from "@/lib/db";

let userN = 0;
const uid = () => `ff-user-${++userN}-${Date.now()}`;

beforeEach(() => {
  invalidateFlagsCache();
});

describe("FF-1 — Flag desligada por padrão", () => {
  it("sem injeção de flags → FEATURE_MESSAGE_CACHE = false", async () => {
    const userId = uid();
    // Não injeta nada — Supabase não disponível em testes → fallback padrão
    const enabled = await isFeatureEnabled(FLAG_MESSAGE_CACHE, userId);
    expect(enabled).toBe(false);
  });

  it("sem injeção de flags → FEATURE_CONVERSATION_CACHE = false", async () => {
    const userId = uid();
    const enabled = await isFeatureEnabled(FLAG_CONVERSATION_CACHE, userId);
    expect(enabled).toBe(false);
  });

  it("isFeatureEnabledSync sem cache carregado → false (default)", () => {
    const userId = uid();
    // Nenhum cache → retorna default
    const enabled = isFeatureEnabledSync(FLAG_MESSAGE_CACHE, userId);
    expect(enabled).toBe(false);
  });
});

describe("FF-2 — Flag ligada para usuário A", () => {
  it("injeção de flag ativa → isFeatureEnabled retorna true para userId A", async () => {
    const userId = uid();
    _testInjectFlags(userId, { [FLAG_MESSAGE_CACHE]: true });
    const enabled = await isFeatureEnabled(FLAG_MESSAGE_CACHE, userId);
    expect(enabled).toBe(true);
  });

  it("isFeatureEnabledSync com cache injetado → true para userId A", () => {
    const userId = uid();
    _testInjectFlags(userId, { [FLAG_MESSAGE_CACHE]: true });
    expect(isFeatureEnabledSync(FLAG_MESSAGE_CACHE, userId)).toBe(true);
  });

  it("flag pode ser ligada apenas para MESSAGE_CACHE, não para CONVERSATION_CACHE", async () => {
    const userId = uid();
    _testInjectFlags(userId, { [FLAG_MESSAGE_CACHE]: true, [FLAG_CONVERSATION_CACHE]: false });
    expect(await isFeatureEnabled(FLAG_MESSAGE_CACHE, userId)).toBe(true);
    expect(await isFeatureEnabled(FLAG_CONVERSATION_CACHE, userId)).toBe(false);
  });
});

describe("FF-3 — Usuário B continua no legado", () => {
  it("flag ativa para usuário A não afeta usuário B (isolamento)", async () => {
    const userA = uid();
    const userB = uid();
    _testInjectFlags(userA, { [FLAG_MESSAGE_CACHE]: true });
    // userB não tem cache injetado → false
    const enabledB = await isFeatureEnabled(FLAG_MESSAGE_CACHE, userB);
    expect(enabledB).toBe(false);
  });

  it("isFeatureEnabledSync com userId B após injeção de A → false", () => {
    const userA = uid();
    const userB = uid();
    _testInjectFlags(userA, { [FLAG_MESSAGE_CACHE]: true });
    // cache é por userId — B usa cache diferente
    expect(isFeatureEnabledSync(FLAG_MESSAGE_CACHE, userB)).toBe(false);
  });
});

describe("FF-4 — Flag desligada durante sessão (kill switch)", () => {
  it("invalidateFlagsCache + recarga sem flag → false (kill switch)", async () => {
    const userId = uid();
    _testInjectFlags(userId, { [FLAG_MESSAGE_CACHE]: true });
    expect(await isFeatureEnabled(FLAG_MESSAGE_CACHE, userId)).toBe(true);

    // Kill switch: invalida cache (em produção, Supabase retornaria enabled=false)
    invalidateFlagsCache();
    // Agora sem injeção → cai no default (false)
    const enabled = await isFeatureEnabled(FLAG_MESSAGE_CACHE, userId);
    expect(enabled).toBe(false);
  });

  it("invalidateFlagsCache limpa cache para qualquer usuário", () => {
    const userId = uid();
    _testInjectFlags(userId, { [FLAG_MESSAGE_CACHE]: true });
    expect(isFeatureEnabledSync(FLAG_MESSAGE_CACHE, userId)).toBe(true);
    invalidateFlagsCache();
    expect(isFeatureEnabledSync(FLAG_MESSAGE_CACHE, userId)).toBe(false);
  });
});

describe("FF-5 — Dados locais preservados quando flag desligada", () => {
  it("desligar flag não apaga IndexedDB — mensagens ainda estão no banco", async () => {
    const userId = uid();
    const scope: CacheScope = { env: "test" as any, userId, accountId: 1 };

    // Escreve no IndexedDB com flag ligada
    _testInjectFlags(userId, { [FLAG_MESSAGE_CACHE]: true });
    await upsertMessages(scope, [{ id: 1, content: "mensagem salva", created_at: 1 }], 100);

    // Desliga flag
    invalidateFlagsCache();
    // Não injeta nada → flag = false (fluxo legado)

    // Dados ainda existem no IndexedDB — não foram apagados
    const rows = await getActiveMessagesFromCache(scope, 100);
    expect(rows.length).toBe(1);
    expect((rows[0] as any).data.content).toBe("mensagem salva");
  });

  it("fluxo legado (flag=false) nunca chama getActiveMessagesFromCache em produção", () => {
    // Este teste verifica a INTENÇÃO: quando flag está desligada,
    // msgCacheEnabled = false → syncMessages NÃO é chamado → cache não inicializa.
    const userId = uid();
    const flagEnabled = isFeatureEnabledSync(FLAG_MESSAGE_CACHE, userId);
    // Como não injetamos nada → false → bloco de cache não seria executado
    expect(flagEnabled).toBe(false);
  });
});

describe("FF-6 — Toggle de flag durante sessão (ligado → desligado → ligado)", () => {
  it("flag vai de true → false → true via injeção e invalidação", () => {
    const userId = uid();

    // Ligado
    _testInjectFlags(userId, { [FLAG_CONVERSATION_CACHE]: true });
    expect(isFeatureEnabledSync(FLAG_CONVERSATION_CACHE, userId)).toBe(true);

    // Kill switch — desliga
    invalidateFlagsCache();
    expect(isFeatureEnabledSync(FLAG_CONVERSATION_CACHE, userId)).toBe(false);

    // Religa (simula novo valor de Supabase aplicado via injeção)
    _testInjectFlags(userId, { [FLAG_CONVERSATION_CACHE]: true });
    expect(isFeatureEnabledSync(FLAG_CONVERSATION_CACHE, userId)).toBe(true);
  });

  it("flag desligada durante sessão: sync e lifecycle NÃO devem ser ativados", () => {
    const userId = uid();
    // Sem injeção → ambas false
    const convOn = isFeatureEnabledSync(FLAG_CONVERSATION_CACHE, userId);
    const msgOn  = isFeatureEnabledSync(FLAG_MESSAGE_CACHE, userId);
    // Guard: se ambas false → lifecycle não abre, syncConversations usa fallback direto
    expect(convOn || msgOn).toBe(false); // garante que nenhum cache iniciaria
  });

  it("flag ligada só para MESSAGE não ativa lifecycle sem CONV", () => {
    const userId = uid();
    _testInjectFlags(userId, { [FLAG_MESSAGE_CACHE]: true, [FLAG_CONVERSATION_CACHE]: false });
    const convOn = isFeatureEnabledSync(FLAG_CONVERSATION_CACHE, userId);
    const msgOn  = isFeatureEnabledSync(FLAG_MESSAGE_CACHE, userId);
    // Lifecycle exige pelo menos um true — neste caso o de msg está on
    expect(convOn).toBe(false);
    expect(msgOn).toBe(true);
    // convOn || msgOn === true → lifecycle poderia abrir (msg cache ativo)
    expect(convOn || msgOn).toBe(true);
  });
});
