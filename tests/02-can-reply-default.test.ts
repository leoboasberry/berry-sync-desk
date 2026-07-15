/**
 * T02 — Janela de 24h: `can_reply` default inseguro
 *
 * Bug alvo: chatwoot.functions.ts:175
 *   return { msgs, can_reply: convData?.can_reply ?? true };
 *
 * Quando o Chatwoot retorna erro ou timeout, can_reply vai a `true`
 * permitindo envio de texto livre fora da janela de 24h.
 *
 * STATUS ESPERADO: FALHA nos casos C e E (demonstrando o bug)
 */

import { describe, it, expect, afterAll } from "vitest";
import { newTrace, recordEvidence, printEvidenceSummary } from "./evidence-log";

// ── Simulação da lógica atual (chatwoot.functions.ts:169–175) ────────────────
type ConvData = { can_reply: boolean } | null;

function currentImpl(convData: ConvData): { can_reply: boolean } {
  // CÓPIA EXATA da linha 175
  return { msgs: [], can_reply: convData?.can_reply ?? true } as any;
}

// ── Comportamento proposto (seguro) ──────────────────────────────────────────
type ReplyPermission =
  | { status: "allowed";  source: string; expiresAt?: string }
  | { status: "blocked";  source: string; reason: string }
  | { status: "unknown";  source: string; error: string };

function safeImpl(convData: ConvData, fetchError?: string): ReplyPermission {
  if (fetchError) {
    return { status: "unknown", source: "chatwoot_fetch_error", error: fetchError };
  }
  if (convData === null) {
    return { status: "unknown", source: "chatwoot_no_data", error: "convRes.ok was false" };
  }
  return convData.can_reply
    ? { status: "allowed", source: "chatwoot" }
    : { status: "blocked", source: "chatwoot", reason: "24h window expired" };
}

const traceId = newTrace();
afterAll(() => printEvidenceSummary());

describe("T02 — can_reply default inseguro", () => {
  it("Caso A — janela aberta: can_reply = true", () => {
    const result = currentImpl({ can_reply: true });
    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T02-window-open", step: "Chatwoot retorna can_reply=true",
      status: result.can_reply ? "PASS" : "FAIL",
      expected: true, actual: result.can_reply,
    });
    expect(result.can_reply).toBe(true);
  });

  it("Caso B — janela fechada: can_reply = false", () => {
    const result = currentImpl({ can_reply: false });
    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T02-window-closed", step: "Chatwoot retorna can_reply=false",
      status: !result.can_reply ? "PASS" : "FAIL",
      expected: false, actual: result.can_reply,
    });
    expect(result.can_reply).toBe(false);
  });

  it("Caso C — BUG: erro de rede → can_reply vai a TRUE (deveria ser false/unknown)", () => {
    // Simula convRes.ok === false → convData = null
    const convData: ConvData = null;
    const result = currentImpl(convData);

    const isBug = result.can_reply === true; // bug confirmado se true
    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T02-network-error", step: "Chatwoot request falha, convData=null",
      status: isBug ? "FAIL" : "PASS",
      assertion: "can_reply deve ser false ou unknown quando Chatwoot não responde",
      expected: false,
      actual: result.can_reply,
      error: isBug
        ? "BUG CONFIRMADO: falha de rede resulta em can_reply=true — mensagem pode ser enviada fora da janela de 24h"
        : undefined,
      file: "src/lib/chatwoot.functions.ts",
      line: 175,
    });

    // RED TEST — vai falhar com a implementação atual, provando o bug
    expect(result.can_reply).toBe(false);
  });

  it("Caso D — conversão explícita confirma a origem do bug: `null?.can_reply` é undefined, `?? true` captura", () => {
    const convData: ConvData = null;
    const rawExpression = convData?.can_reply ?? true;

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T02-null-coalesce", step: "null?.can_reply ?? true avalia para true",
      status: rawExpression === true ? "FAIL" : "PASS",
      assertion: "null?.can_reply ?? true === true demonstra o caminho do bug",
      expected: "false ou undefined",
      actual: rawExpression,
      error: "A expressão `convData?.can_reply ?? true` na linha 175 produz `true` quando convData é null",
    });

    expect(rawExpression).toBe(true); // PASS — prova que o bug existe
  });

  it("Caso E — implementação segura retorna unknown em caso de erro", () => {
    const result = safeImpl(null, "timeout");
    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T02-safe-impl", step: "safeImpl com erro retorna status=unknown",
      status: result.status === "unknown" ? "PASS" : "FAIL",
      expected: "unknown", actual: result.status,
    });
    expect(result.status).toBe("unknown");
    expect((result as any).error).toBeDefined();
  });

  it("Caso F — implementação segura não permite envio quando status=unknown", () => {
    const result = safeImpl(null);
    const canSend = result.status === "allowed";

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T02-unknown-blocks-send", step: "status=unknown deve bloquear envio",
      status: !canSend ? "PASS" : "FAIL",
      expected: false, actual: canSend,
    });
    expect(canSend).toBe(false);
  });

  describe("Janela de 24h — regras de negócio", () => {
    it("Template aceito não deve, por si só, alterar can_reply (janela é baseada em resposta do cliente)", () => {
      // O sistema atual delega 100% ao Chatwoot — não há cálculo local
      // Este teste documenta que não existe lógica local de can_reply fora de line 175
      const before = currentImpl({ can_reply: false });
      // Simula: template enviado, cliente ainda não respondeu, Chatwoot ainda retorna false
      const after = currentImpl({ can_reply: false });

      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T02-template-no-window", step: "Template enviado mas janela permanece fechada",
        status: !after.can_reply ? "PASS" : "FAIL",
        expected: false, actual: after.can_reply,
      });
      expect(after.can_reply).toBe(false);
    });

    it("Frontend e backend usam a mesma fonte — Chatwoot — mas frontend pode ficar desatualizado", () => {
      // Risco: activeConversation.can_reply no state React pode ser stale
      // O polling de mensagens (10s) é o único mecanismo de atualização
      // Entre 2 polls, cliente pode enviar mensagem com janela já fechada

      const staleState = { can_reply: true }; // estado no React
      const freshFromChatwoot = { can_reply: false }; // Chatwoot atualizou

      const divergent = staleState.can_reply !== freshFromChatwoot.can_reply;
      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T02-stale-state", step: "Estado React pode divergir do Chatwoot por até 10s",
        status: "WARNING",
        assertion: "Durante o intervalo de polling (10s), can_reply pode estar desatualizado no frontend",
        expected: "sincronizado", actual: divergent ? "divergente por até 10s" : "sincronizado",
      });
      // Documentação — não é falha automática, mas risco conhecido
      expect(divergent).toBe(true); // prova que o cenário é possível
    });
  });
});
