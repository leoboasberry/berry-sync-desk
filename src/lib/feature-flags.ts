// ── feature-flags.ts ──────────────────────────────────────────────────────────
//
// Flags de feature com kill switch sem redeploy.
//
// Hierarquia de resolução (primeira fonte que responde vence):
//   1. Supabase tabela `feature_flags` (lida com service role → não editável por agentes)
//   2. localStorage (apenas para testes locais / QA — nunca em produção real)
//   3. padrão = false (desabilitado por default)
//
// MIGRAÇÃO NECESSÁRIA antes de produção:
//   ver supabase/migrations/20260716_feature_flags.sql
//
// Kill switch: atualizar `enabled=false` na tabela Supabase → sem redeploy.
// Ativação por usuário: coluna `enabled_for_users uuid[]`.

import { supabase } from "@/integrations/supabase/client";

// ── Nomes de flags conhecidas ─────────────────────────────────────────────────

export const FLAG_CONVERSATION_CACHE = "FEATURE_CONVERSATION_CACHE";
export const FLAG_MESSAGE_CACHE = "FEATURE_MESSAGE_CACHE";

export type KnownFlag =
  | typeof FLAG_CONVERSATION_CACHE
  | typeof FLAG_MESSAGE_CACHE;

// ── Valor padrão quando a tabela não existe ou não há entrada ─────────────────

const DEFAULTS: Record<KnownFlag, boolean> = {
  [FLAG_CONVERSATION_CACHE]: false,
  [FLAG_MESSAGE_CACHE]: false,
};

// ── Cache em memória por sessão (recarregado na mudança de usuário) ───────────

type FlagCache = {
  userId: string;
  flags: Record<string, boolean>;
  loadedAt: number;
};

let _memCache: FlagCache | null = null;
// 15s — kill switch propaga em até 15s sem redeploy ou reload manual
const CACHE_TTL_MS = 15_000;

// ── Leitura da tabela Supabase ────────────────────────────────────────────────
// Retorna null se a tabela não existir ainda (pré-migration).

async function loadFromSupabase(userId: string): Promise<Record<string, boolean> | null> {
  try {
    const { data, error } = await (supabase as any)
      .from("feature_flags")
      .select("flag_name, enabled, enabled_for_users")
      .in("flag_name", [FLAG_CONVERSATION_CACHE, FLAG_MESSAGE_CACHE]);

    if (error) {
      // Tabela não existe (pré-migration) → fallback silencioso
      if (error.code === "42P01") return null;
      console.warn("[feature-flags] Supabase read error:", error.message);
      return null;
    }

    const result: Record<string, boolean> = {};
    for (const row of (data as any[]) ?? []) {
      const enabledForAll = row.enabled === true;
      const enabledForUser =
        Array.isArray(row.enabled_for_users) &&
        row.enabled_for_users.includes(userId);
      result[row.flag_name as string] = enabledForAll || enabledForUser;
    }
    return result;
  } catch {
    return null;
  }
}

// ── Leitura de localStorage (override local — apenas QA/dev) ─────────────────
// Formato: localStorage.setItem("berry_ff_FEATURE_MESSAGE_CACHE", "true")

function readLocalOverride(flag: string): boolean | null {
  try {
    const raw = localStorage.getItem(`berry_ff_${flag}`);
    if (raw === null) return null;
    return raw === "true";
  } catch {
    return null;
  }
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Retorna true se a flag está habilitada para este usuário.
 * Usa cache em memória com TTL de 60s para não bater o Supabase a cada render.
 */
export async function isFeatureEnabled(
  flag: KnownFlag,
  userId: string
): Promise<boolean> {
  const now = Date.now();

  // Cache de memória ainda válido para este usuário?
  if (_memCache && _memCache.userId === userId && now - _memCache.loadedAt < CACHE_TTL_MS) {
    return _memCache.flags[flag] ?? DEFAULTS[flag];
  }

  // Recarregar
  const fromSupabase = await loadFromSupabase(userId);
  const flags: Record<string, boolean> = { ...DEFAULTS };

  if (fromSupabase) {
    Object.assign(flags, fromSupabase);
  } else {
    // Fallback: localStorage override (QA/dev)
    for (const f of [FLAG_CONVERSATION_CACHE, FLAG_MESSAGE_CACHE]) {
      const local = readLocalOverride(f);
      if (local !== null) flags[f] = local;
    }
  }

  _memCache = { userId, flags, loadedAt: now };
  return flags[flag] ?? DEFAULTS[flag];
}

/**
 * Versão síncrona — usa apenas o cache em memória.
 * Retorna o valor cacheado ou o padrão (false) se ainda não carregado.
 * Use após isFeatureEnabled() ter sido chamado ao menos uma vez.
 */
export function isFeatureEnabledSync(flag: KnownFlag, userId: string): boolean {
  if (!_memCache || _memCache.userId !== userId) return DEFAULTS[flag];
  return _memCache.flags[flag] ?? DEFAULTS[flag];
}

/**
 * Invalida o cache de memória — força recarga na próxima chamada.
 * Chamar ao fazer logout ou troca de usuário.
 */
export function invalidateFlagsCache(): void {
  _memCache = null;
}

/**
 * Injeta flags diretamente no cache de memória — usado apenas em testes.
 * Nunca chamar em código de produção.
 */
export function _testInjectFlags(userId: string, flags: Partial<Record<KnownFlag, boolean>>): void {
  _memCache = {
    userId,
    flags: { ...DEFAULTS, ...flags },
    loadedAt: Date.now(),
  };
}
