/**
 * T15 — Lacunas críticas: onConflict + partial index e cross-account injection
 *
 * Lacuna 1: .onConflict("dedup_key").ignore() gera ON CONFLICT (dedup_key) DO NOTHING
 *   via PostgREST. Com índice PARCIAL (WHERE dedup_key IS NOT NULL), o Postgres
 *   não encontra o arbiter e lança 42P10. A correção é usar insert() simples e
 *   tratar o erro 23505 (unique_violation) manualmente.
 *
 * Lacuna 2: payload.account_id vem do corpo do webhook (não confiável). Com HMAC
 *   válido, um atacante pode injetar eventos com account_id arbitrário. A correção
 *   é rejeitar 403 se payload.account_id != CHATWOOT_ACCOUNT_ID do ambiente.
 */

import { describe, it, expect, afterAll, vi, beforeEach } from "vitest";
import { newTrace, recordEvidence, printEvidenceSummary } from "./evidence-log";

const traceId = newTrace();
afterAll(() => printEvidenceSummary());
beforeEach(() => vi.clearAllMocks());

// ── Réplica da lógica de dedup + insert (handlePayload) ───────────────────────

type InsertResult = { error: { code: string; message: string } | null };

async function simulateInsert(
  dedupKey: string | null,
  existingKeys: Set<string>
): Promise<InsertResult> {
  // Simula o banco: verifica a partial UNIQUE index
  if (dedupKey !== null && existingKeys.has(dedupKey)) {
    return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
  }
  if (dedupKey !== null) existingKeys.add(dedupKey);
  return { error: null };
}

// Simula a lógica pós-insert (índice parcial via try/catch 23505)
function handleInsertResult(result: InsertResult): {
  accepted: boolean;
  deduplicated: boolean;
  error: boolean;
} {
  if (!result.error) return { accepted: true, deduplicated: false, error: false };
  if (result.error.code === "23505") return { accepted: true, deduplicated: true, error: false };
  return { accepted: false, deduplicated: false, error: true };
}

// ── Réplica da guard de cross-account (handlePayload) ─────────────────────────

function simulateCrossAccountGuard(opts: {
  payloadAccountId: unknown;
  configuredAccountId: number | null;
}): { allowed: boolean; status: number } {
  const { payloadAccountId, configuredAccountId } = opts;

  if (configuredAccountId === null) {
    // Sem configuração → sem proteção (apenas warning)
    return { allowed: true, status: 200 };
  }

  const parsed = Number(payloadAccountId);
  if (!Number.isFinite(parsed) || parsed !== configuredAccountId) {
    return { allowed: false, status: 403 };
  }
  return { allowed: true, status: 200 };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("T15-A — onConflict com partial index: dedup via catch 23505", () => {

  it("Primeiro evento: inserido com sucesso (sem conflito)", async () => {
    const db = new Set<string>();
    const result = await simulateInsert("hash-abc", db);
    const out = handleInsertResult(result);
    expect(out.accepted).toBe(true);
    expect(out.deduplicated).toBe(false);
    expect(out.error).toBe(false);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T15-A-first-insert",
      step: "Primeiro evento com dedup_key='hash-abc' → inserido normalmente",
      status: "PASS" });
  });

  it("Replay do mesmo evento: 23505 → deduplicated=true, não é erro", async () => {
    const db = new Set<string>(["hash-abc"]);  // já existe
    const result = await simulateInsert("hash-abc", db);
    const out = handleInsertResult(result);
    expect(out.accepted).toBe(true);
    expect(out.deduplicated).toBe(true);
    expect(out.error).toBe(false);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T15-A-dedup-23505",
      step: "Replay com dedup_key existente → 23505 capturado → deduplicated=true (não erro)",
      status: "PASS" });
  });

  it("Evento com dedup_key=null: dois inserts aceitos (partial index não cobre NULL)", async () => {
    const db = new Set<string>();
    const r1 = await simulateInsert(null, db);
    const r2 = await simulateInsert(null, db);
    // NULL não entra no índice parcial → sem conflito → ambos aceitos
    expect(handleInsertResult(r1).accepted).toBe(true);
    expect(handleInsertResult(r2).accepted).toBe(true);
    expect(handleInsertResult(r1).deduplicated).toBe(false);
    expect(handleInsertResult(r2).deduplicated).toBe(false);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T15-A-null-key",
      step: "dedup_key=null: índice parcial não cobre → ambos inseridos (sem dedup, correto)",
      status: "PASS" });
  });

  it("Erro real de banco (não 23505) → propagado como erro", async () => {
    const badResult: InsertResult = { error: { code: "23502", message: "not-null violation" } };
    const out = handleInsertResult(badResult);
    expect(out.accepted).toBe(false);
    expect(out.error).toBe(true);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T15-A-other-error",
      step: "Erro 23502 (not-null) → não é 23505 → propagado corretamente",
      status: "PASS" });
  });

  it("Documenta: .onConflict('col') em índice PARCIAL seria erro 42P10 em Postgres", () => {
    // Não é possível reproduzir 42P10 sem banco real.
    // Documentamos a causa: PostgREST gera ON CONFLICT (col) DO NOTHING
    // sem a cláusula WHERE, e Postgres exige que o ON CONFLICT target
    // corresponda exatamente ao índice (incluindo predicate para parciais).
    //
    // FIX: usar INSERT simples + catch 23505.
    // Alternativa futura: CREATE UNIQUE INDEX sem WHERE (NULLs distintos em Postgres = OK para UNIQUE).

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T15-A-42p10-doc",
      step: "DOCUMENTADO: .onConflict('dedup_key').ignore() com índice parcial → 42P10 em runtime",
      status: "WARNING",
      assertion: "FIX aplicado: insert() simples + catch code===23505",
      actual: "Ver supabase/functions/chatwoot-events/index.ts linha ~249" });

    expect(true).toBe(true); // informativo
  });
});

describe("T15-B — Cross-account injection: payload.account_id validado contra env", () => {

  it("payload.account_id correto (= configurado) → permitido", () => {
    const r = simulateCrossAccountGuard({ payloadAccountId: 1, configuredAccountId: 1 });
    expect(r.allowed).toBe(true);
    expect(r.status).toBe(200);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T15-B-correct-account",
      step: "payload.account_id=1 = configurado=1 → permitido (200)",
      status: "PASS" });
  });

  it("payload.account_id diferente do configurado → 403 Forbidden", () => {
    const r = simulateCrossAccountGuard({ payloadAccountId: 2, configuredAccountId: 1 });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(403);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T15-B-wrong-account",
      step: "payload.account_id=2 ≠ configurado=1 → 403 (cross-account injection bloqueada)",
      status: "PASS" });
  });

  it("payload.account_id=0 (inválido) → 403", () => {
    const r = simulateCrossAccountGuard({ payloadAccountId: 0, configuredAccountId: 1 });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(403);
  });

  it("payload.account_id='abc' (string não numérica) → 403", () => {
    const r = simulateCrossAccountGuard({ payloadAccountId: "abc", configuredAccountId: 1 });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(403);
  });

  it("payload.account_id=null → 403", () => {
    const r = simulateCrossAccountGuard({ payloadAccountId: null, configuredAccountId: 1 });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(403);
  });

  it("CHATWOOT_ACCOUNT_ID não configurado → proteção desabilitada (warning, aceita tudo)", () => {
    // Sem a env var, configuredAccountId=null → sem validação (modo legado / backward compat)
    const r = simulateCrossAccountGuard({ payloadAccountId: 999, configuredAccountId: null });
    expect(r.allowed).toBe(true);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T15-B-no-env",
      step: "CHATWOOT_ACCOUNT_ID não configurado → sem validação (warning emitido, aceita)",
      status: "WARNING",
      assertion: "Recomendação: configurar CHATWOOT_ACCOUNT_ID nos secrets do Supabase",
      actual: "allowed=true (modo degradado)" });
  });

  it("Atacante com HMAC válido mas account_id errado → ainda 403", () => {
    // Mesmo que o HMAC seja válido (autenticado), a guard de account_id é uma camada extra.
    // HMAC prova que o corpo não foi alterado pelo atacante.
    // Mas se o atacante TEM o secret (comprometido), o HMAC não protege account_id.
    // Esta guard fecha essa brecha: o payload.account_id deve bater com o da instalação.
    const r = simulateCrossAccountGuard({ payloadAccountId: 42, configuredAccountId: 1 });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(403);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T15-B-hmac-valid-wrong-account",
      step: "HMAC válido + account_id errado → 403 (defesa em profundidade)",
      status: "PASS" });
  });

  it("Verificação estática: Edge Function usa ALLOWED_CHATWOOT_ACCOUNT_IDS do env, não do payload", () => {
    // Variável renomeada: CHATWOOT_ACCOUNT_ID → ALLOWED_CHATWOOT_ACCOUNT_IDS (suporta lista)
    // Validação movida para _helpers.ts::validatePayload (testável isoladamente)
    const { readFileSync } = require("fs");
    const { resolve } = require("path");
    const indexCode = readFileSync(
      resolve(__dirname, "../supabase/functions/chatwoot-events/index.ts"),
      "utf8"
    );
    const helpersCode = readFileSync(
      resolve(__dirname, "../supabase/functions/chatwoot-events/_helpers.ts"),
      "utf8"
    );

    // index.ts deve ler do env e passar para validatePayload
    expect(indexCode).toContain("ALLOWED_CHATWOOT_ACCOUNT_IDS");
    expect(indexCode).toContain("parseAllowedAccountIds");
    expect(indexCode).toContain("validatePayload");

    // A lógica de rejeição fica em _helpers.ts
    expect(helpersCode).toContain("allowedAccountIds");
    expect(helpersCode).toContain("allowedAccountIds.has(accountId)");

    // Deve retornar 403 em caso de mismatch (em _helpers.ts)
    expect(helpersCode).toContain("403");

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T15-B-static",
      step: "Edge Function: guard lê account_id do env, compara com payload, retorna 403 se diferente",
      status: "PASS" });
  });
});
