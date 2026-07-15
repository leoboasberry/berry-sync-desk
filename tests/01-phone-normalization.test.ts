/**
 * T01 — Normalização de telefone
 *
 * Evidencia:
 *  - 4 implementações divergentes identificadas (index.tsx, chatwoot.functions.ts,
 *    hubspot.functions.ts, startConversationWithTemplate)
 *  - Testa idempotência, cobertura de formatos e consistência cross-path
 *
 * Status esperado: ALGUNS TESTES DEVEM FALHAR (demonstrando o risco)
 */

import { describe, it, expect, afterAll } from "vitest";
import { newTrace, recordEvidence, printEvidenceSummary } from "./evidence-log";

// ── Implementação extraída de index.tsx:90–98 (client-side) ──────────────────
function normalizePhoneClient(raw: string | null | undefined): string {
  if (!raw) return "";
  const d = raw.replace(/\D/g, "");
  if (d.length === 13 && d.startsWith("55")) return d;
  if (d.length === 12 && d.startsWith("55")) return d.slice(0, 4) + "9" + d.slice(4);
  if (d.length === 11) return "55" + d;
  if (d.length === 10) return "55" + d.slice(0, 2) + "9" + d.slice(2);
  return d;
}

// ── Implementação extraída de chatwoot.functions.ts:108–121 (server-side) ────
function normalizePhoneServer(raw: string | null | undefined): string {
  if (!raw) return "";
  const d = raw.replace(/\D/g, "");
  if (d.length === 13 && d.startsWith("55")) return d;
  if (d.length === 12 && d.startsWith("55")) return d.slice(0, 4) + "9" + d.slice(4);
  if (d.length === 11) return "55" + d;
  if (d.length === 10) return "55" + d.slice(0, 2) + "9" + d.slice(2);
  return d;
}

// ── Implementação extraída de hubspot.functions.ts:151–158 (HubSpot path) ────
function normalizePhoneHubspot(raw: string): { localPhone: string; last9: string } {
  const digits = raw.replace(/\D/g, "");
  const localPhone = digits.startsWith("55") ? digits.slice(2) : digits;
  const last9 = localPhone.length > 9 ? localPhone.slice(-9) : localPhone;
  return { localPhone, last9 };
}

// ── Implementação extraída de chatwoot.functions.ts:585 (E.164 para novo contato) ──
function normalizePhoneE164(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  return digits.startsWith("+") ? digits : "+" + digits;
}

// ── Casos de teste ────────────────────────────────────────────────────────────
const CASES: Array<{
  input: string;
  expectedCanonical: string; // forma correta esperada em todos os paths
  description: string;
}> = [
  { input: "+55 (48) 9 9829-9242", expectedCanonical: "5548998299242", description: "E.164 formatado" },
  { input: "5548998299242",         expectedCanonical: "5548998299242", description: "13 dígitos canônico" },
  { input: "48998299242",           expectedCanonical: "5548998299242", description: "11 dígitos sem DDI" },
  { input: "4898299242",            expectedCanonical: "5548998299242", description: "10 dígitos sem DDI e sem 9" },
  { input: "554898299242",          expectedCanonical: "5548998299242", description: "12 dígitos DDI+area+8dig" },
  { input: "+5548998299242",        expectedCanonical: "5548998299242", description: "E.164 com +" },
  { input: "5565999615067",         expectedCanonical: "5565999615067", description: "2º contato autorizado" },
  { input: "65999615067",           expectedCanonical: "5565999615067", description: "2º contato sem DDI" },
  // Edge cases
  { input: "11912345678",           expectedCanonical: "5511912345678", description: "SP 9-dígito sem DDI" },
  { input: "1112345678",            expectedCanonical: "5511912345678", description: "SP 8-dígito sem DDI" },
  { input: "+1 (555) 123-4567",     expectedCanonical: "15551234567",   description: "Número internacional EUA" },
];

const traceId = newTrace();

afterAll(() => printEvidenceSummary());

describe("T01 — Normalização de telefone", () => {
  describe("Client vs Server — devem ser idênticos", () => {
    for (const c of CASES) {
      it(`[${c.description}] client === server para "${c.input}"`, () => {
        const client = normalizePhoneClient(c.input);
        const server = normalizePhoneServer(c.input);

        const pass = client === server;
        recordEvidence({
          traceId,
          timestamp: new Date().toISOString(),
          scenario: "T01-client-vs-server",
          step: c.description,
          status: pass ? "PASS" : "FAIL",
          assertion: `client("${c.input}") === server("${c.input}")`,
          expected: server,
          actual: client,
        });

        expect(client).toBe(server);
      });
    }
  });

  describe("Idempotência — normalizar duas vezes deve dar o mesmo resultado", () => {
    for (const c of CASES) {
      it(`[${c.description}] idempotente para "${c.input}"`, () => {
        const once = normalizePhoneClient(c.input);
        const twice = normalizePhoneClient(once);

        const pass = once === twice;
        recordEvidence({
          traceId,
          timestamp: new Date().toISOString(),
          scenario: "T01-idempotency",
          step: c.description,
          status: pass ? "PASS" : "FAIL",
          assertion: `normalizePhone(normalizePhone("${c.input}")) === normalizePhone("${c.input}")`,
          expected: once,
          actual: twice,
        });

        expect(twice).toBe(once);
      });
    }
  });

  describe("HubSpot path — divergência intencional a documentar", () => {
    it("HubSpot remove DDI 55 — chave diferente do cache canônico", () => {
      const canonical = normalizePhoneClient("5548998299242");
      const { localPhone } = normalizePhoneHubspot("5548998299242");

      // Este DEVE ser diferente — é a divergência que causa bugs de owner filter
      const isDivergent = canonical !== localPhone;
      recordEvidence({
        traceId,
        timestamp: new Date().toISOString(),
        scenario: "T01-hubspot-divergence",
        step: "HubSpot strips DDI, canonical keeps it",
        status: isDivergent ? "FAIL" : "PASS",
        assertion: "canonical !== hubspot_localPhone demonstra chaves incompatíveis",
        expected: "5548998299242",
        actual: localPhone,
        error: isDivergent
          ? `BUG CONFIRMADO: cache usa chave "${canonical}" mas HubSpot busca com "${localPhone}"`
          : undefined,
      });

      // Falha intencional para documentar o bug
      expect(canonical).toBe(localPhone); // RED TEST — documenta divergência
    });

    it("Número sem DDI entra na HubSpot com formato correto mas cache não encontra", () => {
      const raw = "48998299242"; // 11 dígitos
      const canonical = normalizePhoneClient(raw); // → "5548998299242"
      const { localPhone } = normalizePhoneHubspot(canonical); // → "48998299242"
      const cacheKey = canonical; // contact_owner_cache usa canonical

      const wouldCacheHit = cacheKey === localPhone;
      recordEvidence({
        traceId,
        timestamp: new Date().toISOString(),
        scenario: "T01-hubspot-cache-miss",
        step: "Cache miss por divergência de chave",
        status: wouldCacheHit ? "PASS" : "FAIL",
        assertion: `contact_owner_cache["${cacheKey}"] não seria encontrado por busca HubSpot com chave "${localPhone}"`,
        expected: "chaves compatíveis",
        actual: `cache="${cacheKey}" vs hubspot="${localPhone}"`,
      });

      expect(cacheKey).toBe(localPhone); // RED TEST
    });
  });

  describe("E.164 para novo contato — 4º path divergente", () => {
    it("E.164 produz formato diferente do canônico — diferentes chaves de lookup", () => {
      const canonical = normalizePhoneClient("5548998299242"); // "5548998299242"
      const e164 = normalizePhoneE164("5548998299242");          // "+5548998299242"

      const compatible = canonical === e164.replace("+", "");
      recordEvidence({
        traceId,
        timestamp: new Date().toISOString(),
        scenario: "T01-e164-path",
        step: "E.164 vs canonical",
        status: "WARNING",
        assertion: "E.164 usa + prefix que não está presente no canonical",
        expected: canonical,
        actual: e164,
        error: !compatible ? `Chatwoot armazena phone como "${e164}" mas cache usa "${canonical}"` : undefined,
      });

      // Documentar que são compatíveis apenas se ignorar o +
      expect(e164).toBe("+" + canonical);
    });
  });

  describe("Estrutura de retorno proposta (NormalizedPhone)", () => {
    it("Formato atual não fornece metadados — impossível validar validade", () => {
      // A função atual retorna apenas string — sem valid, countryCode, nationalNumber
      const result = normalizePhoneClient("abc");
      // Se input é inválido, retorna a string de dígitos (possivelmente vazia)
      // Não há indicação de validade
      recordEvidence({
        traceId,
        timestamp: new Date().toISOString(),
        scenario: "T01-no-metadata",
        step: "Número inválido não retorna erro",
        status: "WARNING",
        assertion: 'normalizePhone("abc") deveria retornar { valid: false } mas retorna string vazia',
        expected: "{ valid: false, reason: 'no digits' }",
        actual: `"${result}"`,
      });
      expect(typeof result).toBe("string"); // passa — mas documenta limitação
    });
  });
});
