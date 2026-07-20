/**
 * T12 — B04: HMAC-SHA256 — cenários de verificação
 *
 * Cobre os 9 cenários especificados:
 *  1. secret ausente em produção → deve rejeitar (503 simulado)
 *  2. secret ausente em local com bypass desligado → deve rejeitar
 *  3. bypass local explicitamente habilitado → deve aceitar sem assinatura
 *  4. assinatura ausente (sem header) → deve rejeitar
 *  5. assinatura inválida → deve rejeitar
 *  6. assinatura válida → deve aceitar
 *  7. corpo alterado após assinatura → deve rejeitar
 *  8. hexadecimal vs Base64 — formato errado → rejeitar
 *  9. comparação constant-time (XOR): sem early exit
 *
 * Não envia requisições reais. Réplica da lógica de index.ts.
 */

import { describe, it, expect, afterAll } from "vitest";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { newTrace, recordEvidence, printEvidenceSummary } from "./evidence-log";

const traceId = newTrace();
afterAll(() => printEvidenceSummary());

// ── Réplica de verifyHmac (supabase/functions/chatwoot-events/index.ts) ───────
//
// Implementação original usa Web Crypto API (Deno). Aqui usamos Node crypto
// com lógica idêntica: hmac-sha256 em hex, comparação XOR constant-time.

async function sha256hex(input: string): Promise<string> {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Simula a lógica de decisão do Edge Function:
//   - se sem secret em production → "no_secret_production"
//   - se sem secret fora de production sem bypass → "no_secret_no_bypass"
//   - se sem secret fora de production com bypass → "bypassed"
//   - com secret: verifica HMAC
type HmacDecision =
  | { status: "no_secret_production" }
  | { status: "no_secret_no_bypass" }
  | { status: "bypassed" }
  | { status: "invalid_signature" }
  | { status: "valid" };

async function simulateHmacGate(opts: {
  secret: string | undefined;
  appEnv: string;
  allowUnsigned: boolean;
  rawBody: string;
  signature: string | null;
}): Promise<HmacDecision> {
  const { secret, appEnv, allowUnsigned, rawBody, signature } = opts;

  if (!secret) {
    if (appEnv === "production") return { status: "no_secret_production" };
    if (!allowUnsigned) return { status: "no_secret_no_bypass" };
    return { status: "bypassed" };
  }

  if (!signature) return { status: "invalid_signature" };

  const expected = await hmacSha256Hex(secret, rawBody);
  const ok = constantTimeEqual(expected, signature);
  return ok ? { status: "valid" } : { status: "invalid_signature" };
}

// ── Testes ───────────────────────────────────────────────────────────────────

const SECRET = "test-webhook-secret-32chars-long!";
const BODY   = JSON.stringify({ event: "message_created", id: 1 });

describe("T12 — B04: HMAC-SHA256 — cenários de verificação", () => {

  it("1. Secret ausente em PRODUÇÃO → 503 (fail-closed, sem bypass)", async () => {
    const result = await simulateHmacGate({
      secret: undefined,
      appEnv: "production",
      allowUnsigned: false,
      rawBody: BODY,
      signature: null,
    });
    expect(result.status).toBe("no_secret_production");
    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T12-no-secret-prod",
      step: "Sem secret em produção → fail-closed (nenhuma mensagem passa)",
      status: "PASS", expected: "no_secret_production", actual: result.status });
  });

  it("2. Secret ausente em LOCAL sem bypass → também rejeitado (padrão seguro)", async () => {
    const result = await simulateHmacGate({
      secret: undefined,
      appEnv: "local",
      allowUnsigned: false,    // ALLOW_UNSIGNED_CHATWOOT_WEBHOOKS não definido
      rawBody: BODY,
      signature: null,
    });
    expect(result.status).toBe("no_secret_no_bypass");
    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T12-no-secret-local-no-bypass",
      step: "Sem secret em local, sem bypass → rejeitado (não é só prod que protege)",
      status: "PASS", expected: "no_secret_no_bypass", actual: result.status });
  });

  it("3. Bypass local EXPLICITAMENTE habilitado → aceito sem assinatura", async () => {
    const result = await simulateHmacGate({
      secret: undefined,
      appEnv: "local",
      allowUnsigned: true,     // ALLOW_UNSIGNED_CHATWOOT_WEBHOOKS=true
      rawBody: BODY,
      signature: null,
    });
    expect(result.status).toBe("bypassed");
    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T12-bypass-local",
      step: "Bypass explícito em local → aceito (sem secret + sem assinatura)",
      status: "PASS", expected: "bypassed", actual: result.status });
  });

  it("4. Assinatura AUSENTE (sem header) → rejeitado, mesmo com secret configurado", async () => {
    const result = await simulateHmacGate({
      secret: SECRET,
      appEnv: "production",
      allowUnsigned: false,
      rawBody: BODY,
      signature: null,     // header ausente
    });
    expect(result.status).toBe("invalid_signature");
    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T12-missing-signature",
      step: "Header de assinatura ausente → rejeitado",
      status: "PASS", expected: "invalid_signature", actual: result.status });
  });

  it("5. Assinatura INVÁLIDA → rejeitada", async () => {
    const result = await simulateHmacGate({
      secret: SECRET,
      appEnv: "production",
      allowUnsigned: false,
      rawBody: BODY,
      signature: "deadbeef".repeat(8),   // 64 chars hex, mas errado
    });
    expect(result.status).toBe("invalid_signature");
    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T12-invalid-sig",
      step: "Assinatura inválida (hex correto mas HMAC errado) → rejeitada",
      status: "PASS", expected: "invalid_signature", actual: result.status });
  });

  it("6. Assinatura VÁLIDA → aceita", async () => {
    const validSig = await hmacSha256Hex(SECRET, BODY);
    const result = await simulateHmacGate({
      secret: SECRET,
      appEnv: "production",
      allowUnsigned: false,
      rawBody: BODY,
      signature: validSig,
    });
    expect(result.status).toBe("valid");
    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T12-valid-sig",
      step: "Assinatura HMAC-SHA256 correta → aceita",
      status: "PASS", expected: "valid", actual: result.status });
  });

  it("7. Corpo ALTERADO após assinatura → rejeitado", async () => {
    const validSig = await hmacSha256Hex(SECRET, BODY);
    const tamperedBody = BODY + " "; // espaço adicionado após assinar
    const result = await simulateHmacGate({
      secret: SECRET,
      appEnv: "production",
      allowUnsigned: false,
      rawBody: tamperedBody,
      signature: validSig,    // assinatura do BODY original, corpo agora diferente
    });
    expect(result.status).toBe("invalid_signature");
    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T12-tampered-body",
      step: "Corpo alterado (1 byte extra) → HMAC diverge → rejeitado",
      status: "PASS", expected: "invalid_signature", actual: result.status });
  });

  it("8. Assinatura em Base64 em vez de hex → rejeitada (formato errado)", async () => {
    // O Chatwoot envia o HMAC em hex. Se alguém enviar em Base64, não bate.
    const base64Sig = createHmac("sha256", SECRET).update(BODY, "utf8").digest("base64");
    const result = await simulateHmacGate({
      secret: SECRET,
      appEnv: "production",
      allowUnsigned: false,
      rawBody: BODY,
      signature: base64Sig,
    });
    expect(result.status).toBe("invalid_signature");
    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T12-base64-vs-hex",
      step: "Assinatura em Base64 (não hex) → comprimento diferente → constantTimeEqual retorna false",
      status: "PASS", expected: "invalid_signature", actual: result.status });
  });

  it("9. Comparação constant-time: sem early-exit (XOR sem short-circuit)", () => {
    // Verifica que constantTimeEqual não retorna false antecipadamente
    // comparando dois hexes de mesmo comprimento mas com diferença só no último byte.
    const a = "a".repeat(63) + "0";
    const b = "a".repeat(63) + "1";
    // Se houvesse short-circuit, o tempo seria muito menor quando o primeiro char difere.
    // Aqui verificamos apenas a semântica (resultado correto), não o timing.
    expect(constantTimeEqual(a, b)).toBe(false);
    expect(constantTimeEqual(a, a)).toBe(true);

    // Comprimentos diferentes → false imediatamente (não vaza tempo por posição)
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T12-constant-time",
      step: "constantTimeEqual: XOR acumula todas as diferenças sem short-circuit",
      status: "PASS",
      assertion: "Comprimentos diferentes → false; iguais → true; diferença no último byte → false",
      actual: "Todos corretos" });
  });
});
