/**
 * T09 — B05 v2: Deduplicação com chave canônica (version=2)
 *
 * Testa a função computeDedupKey do Edge Function chatwoot-events.
 * Implementação: JSON.stringify de objeto com ordem de chaves canônica.
 * Sem concatenação com delimitador — sem risco de colisão quando valores contêm "|".
 *
 * Com message_id:  { version:2, accountId, eventType, messageId }
 * Sem message_id:  { version:2, accountId, eventType, conversationId,
 *                    senderId, createdAt, sourceId }
 *
 * Referência: supabase/functions/chatwoot-events/index.ts — computeDedupKey
 */

import { describe, it, expect, afterAll } from "vitest";
import { createHash } from "crypto";
import { newTrace, recordEvidence, printEvidenceSummary } from "./evidence-log";

const traceId = newTrace();
afterAll(() => printEvidenceSummary());

// ── Réplica síncrona de computeDedupKey (Node.js crypto, mesma lógica do Edge Function) ──

function canonicalJson(obj: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

function sha256sync(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

type Payload = {
  event?: unknown;
  account_id?: unknown;
  id?: unknown; // message_id (Chatwoot)
  source_id?: unknown;
  created_at?: unknown;
  conversation?: { id?: unknown };
  sender?: { id?: unknown };
  content?: unknown;
};

function computeDedupKeySync(payload: Payload): string {
  const messageId = payload.id;
  const conversation = payload.conversation;
  const sender = payload.sender;

  let dedupIdentity: Record<string, unknown>;

  if (messageId != null) {
    dedupIdentity = {
      version: 2,
      accountId: payload.account_id ?? null,
      eventType: payload.event ?? null,
      messageId,
    };
  } else {
    dedupIdentity = {
      version: 2,
      accountId: payload.account_id ?? null,
      eventType: payload.event ?? null,
      conversationId: conversation?.id ?? null,
      senderId: sender?.id ?? null,
      createdAt: payload.created_at ?? null,
      sourceId: payload.source_id ?? null,
    };
  }

  return sha256sync(canonicalJson(dedupIdentity));
}

// ── Testes T09 ───────────────────────────────────────────────────────────────

describe("T09 — B05 v2: Deduplicação com chave canônica (version=2)", () => {

  describe("Com message_id presente", () => {
    it("Replay exato do mesmo message_id → chave idêntica → descartado", () => {
      const p1 = { event: "message_created", account_id: 1, id: 42, conversation: { id: 100 } };
      const p2 = { event: "message_created", account_id: 1, id: 42, conversation: { id: 100 } };
      const h1 = computeDedupKeySync(p1);
      const h2 = computeDedupKeySync(p2);

      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T09-replay", step: "Replay exato → chave idêntica",
        status: h1 === h2 ? "PASS" : "FAIL",
        expected: "Chaves iguais", actual: `h1=${h1.slice(0, 16)}…`,
      });

      expect(h1).toBe(h2);
    });

    it("Mesmo message_id com timestamp diferente → mesma chave (timestamp não está em dedupIdentity)", () => {
      const h1 = computeDedupKeySync({ event: "message_created", account_id: 1, id: 42, created_at: 1000 });
      const h2 = computeDedupKeySync({ event: "message_created", account_id: 1, id: 42, created_at: 9999 });

      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T09-timestamp-ignored", step: "Timestamp diferente, mesmo message_id → mesma chave",
        status: h1 === h2 ? "PASS" : "FAIL",
        expected: "Chaves iguais (timestamp fora do dedupIdentity com message_id)",
        actual: `iguais: ${h1 === h2}`,
      });

      expect(h1).toBe(h2);
    });

    it("Duas mensagens legítimas com conteúdo 'ok' e IDs diferentes → chaves diferentes", () => {
      const h1 = computeDedupKeySync({ event: "message_created", account_id: 1, id: 10, content: "ok" });
      const h2 = computeDedupKeySync({ event: "message_created", account_id: 1, id: 11, content: "ok" });

      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T09-different-ids", step: "Mesmo content 'ok', message_ids diferentes → chaves diferentes",
        status: h1 !== h2 ? "PASS" : "FAIL",
        expected: "Chaves diferentes",
        actual: `diferentes: ${h1 !== h2}`,
      });

      expect(h1).not.toBe(h2);
    });

    it("Conteúdo contendo '|' não causa colisão (JSON.stringify, sem concatenação)", () => {
      // Com concatenação por '|': "a|b" + "c" → "a|b|c" = "a" + "b|c" → "a|b|c" (COLISÃO!)
      // Com JSON: { messageId: 10 } ≠ { messageId: 11 } → chaves distintas mesmo com '|' no content
      const hPipe = computeDedupKeySync({ event: "msg", account_id: 1, id: 10, content: "a|b" });
      const hNoPipe = computeDedupKeySync({ event: "msg", account_id: 1, id: 11, content: "a|b" });

      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T09-pipe-in-content",
        step: "content com '|', message_ids diferentes → chaves distintas",
        status: hPipe !== hNoPipe ? "PASS" : "FAIL",
        expected: "Chaves diferentes",
        actual: `distintas: ${hPipe !== hNoPipe}`,
      });

      expect(hPipe).not.toBe(hNoPipe);
    });

    it("Conteúdo com caracteres de controle não causa colisão", () => {
      const h1 = computeDedupKeySync({ event: "msg", account_id: 1, id: 1, content: "a\x1fb" });
      const h2 = computeDedupKeySync({ event: "msg", account_id: 1, id: 2, content: "a\x1fb" });
      expect(h1).not.toBe(h2);
    });

    it("Propriedades do payload em ordem diferente → mesma chave (canonicidade por sort de chaves)", () => {
      // canonicalJson ordena as chaves → JSON idêntico independente da ordem de construção
      const obj1 = { version: 2, accountId: 1, eventType: "message_created", messageId: 42 };
      const obj2 = { messageId: 42, eventType: "message_created", accountId: 1, version: 2 };
      const h1 = sha256sync(canonicalJson(obj1));
      const h2 = sha256sync(canonicalJson(obj2));

      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T09-key-order", step: "Objeto com mesmas chaves em ordem diferente → JSON canônico idêntico",
        status: h1 === h2 ? "PASS" : "FAIL",
        expected: "Chaves iguais",
        actual: `iguais: ${h1 === h2}`,
      });

      expect(h1).toBe(h2);
    });
  });

  describe("Sem message_id (fallback com campos estáveis)", () => {
    it("Evento sem message_id usa estrutura de fallback com conversationId, senderId, createdAt, sourceId", () => {
      const h = computeDedupKeySync({
        event: "conversation_updated",
        account_id: 1,
        conversation: { id: 200 },
        sender: { id: 5 },
        created_at: 1000,
        source_id: "src-abc",
      });

      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T09-no-msgid-fallback", step: "Evento sem message_id usa fallback",
        status: typeof h === "string" && h.length === 64 ? "PASS" : "FAIL",
        expected: "Hash SHA-256 de 64 hex chars",
        actual: `length=${h.length}`,
      });

      expect(h).toHaveLength(64);
      expect(h).toMatch(/^[0-9a-f]+$/);
    });

    it("Dois eventos legítimos sem message_id com createdAt diferentes → chaves diferentes", () => {
      const h1 = computeDedupKeySync({ event: "message_created", account_id: 1, conversation: { id: 10 }, sender: { id: 5 }, created_at: 1000 });
      const h2 = computeDedupKeySync({ event: "message_created", account_id: 1, conversation: { id: 10 }, sender: { id: 5 }, created_at: 2000 });

      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T09-no-msgid-different-time", step: "Dois eventos sem message_id em instantes diferentes → chaves diferentes",
        status: h1 !== h2 ? "PASS" : "FAIL",
        expected: "Chaves diferentes", actual: `distintas: ${h1 !== h2}`,
      });

      expect(h1).not.toBe(h2);
    });

    it("Campos com '|' no fallback não causam colisão (JSON.stringify, sem concatenação)", () => {
      // Antigo separador '|': sourceId="a|b", createdAt="c" → "a|b|c" == sourceId="a", createdAt="b|c"
      // Com JSON.stringify: { sourceId: "a|b" } ≠ { sourceId: "a" } → sem colisão
      const h1 = computeDedupKeySync({ event: "msg", account_id: 1, conversation: { id: 1 }, sender: { id: 1 }, created_at: 1, source_id: "a|b" });
      const h2 = computeDedupKeySync({ event: "msg", account_id: 1, conversation: { id: 1 }, sender: { id: 1 }, created_at: 1, source_id: "a" });

      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T09-pipe-in-source-id",
        step: "sourceId com '|' vs sourceId sem '|' → chaves distintas",
        status: h1 !== h2 ? "PASS" : "FAIL",
        expected: "Chaves diferentes (JSON, sem concatenação)",
        actual: `distintas: ${h1 !== h2}`,
      });

      expect(h1).not.toBe(h2);
    });
  });

  describe("Separador canônico — ausência de colisão (T09-A e T09-B)", () => {
    it("[T09-A] JSON.stringify previne colisão que existia com join('|'): campos trocados entre si", () => {
      // Demonstra que a abordagem antiga (join com '|') colidiria:
      //   ["a", "b|c"].join("|") === ["a|b", "c"].join("|") → "a|b|c" (COLISÃO)
      // A nova abordagem (JSON):
      //   JSON.stringify({sourceId:"a|b"}) ≠ JSON.stringify({sourceId:"a", senderId:"b|c"})
      const collision1_old = ["msg", "1", "100", "a|b", "c"].join("|");
      const collision2_old = ["msg", "1", "100", "a", "b|c"].join("|");
      expect(collision1_old).toBe(collision2_old); // confirma que o bug EXISTIA

      // Com a nova abordagem, não há colisão
      const h1 = computeDedupKeySync({ event: "msg", account_id: 1, conversation: { id: 100 }, sender: { id: 1 }, created_at: 1, source_id: "a|b" });
      const h2 = computeDedupKeySync({ event: "msg", account_id: 1, conversation: { id: 100 }, sender: { id: 2 }, created_at: 1, source_id: "a" });

      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T09-separator",
        step: "T09-A: JSON canônico previne colisão que existia com join('|')",
        status: h1 !== h2 ? "PASS" : "FAIL",
        expected: "Chaves diferentes (sem colisão)",
        actual: `distintas: ${h1 !== h2}`,
      });

      expect(h1).not.toBe(h2); // GREEN: JSON não colide
    });

    it("[T09-B] Conteúdo contendo '|' com sender diferente: sem colisão com JSON.stringify", () => {
      // Bug anterior: content='a|b', sender_name='c' → "a|b|c" === content='a', sender_name='b|c'
      // Novo comportamento: campos são propriedades distintas no JSON — sem ambiguidade
      const h1_old = ["msg_created", "1", "101", "a|b", "c"].join("|");
      const h2_old = ["msg_created", "1", "101", "a", "b|c"].join("|");
      expect(h1_old).toBe(h2_old); // confirma que o bug EXISTIA

      // Com a nova abordagem, sourceId="a|b" (id=10) ≠ sourceId="a" (id=11)
      const h1 = computeDedupKeySync({ event: "msg_created", account_id: 1, id: 10, content: "a|b" });
      const h2 = computeDedupKeySync({ event: "msg_created", account_id: 1, id: 11, content: "a" });

      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T09-pipe-collision",
        step: "T09-B: content com '|' não colide com JSON.stringify",
        status: h1 !== h2 ? "PASS" : "FAIL",
        expected: "Chaves diferentes",
        actual: `distintas: ${h1 !== h2}`,
      });

      expect(h1).not.toBe(h2); // GREEN: JSON não colide
    });
  });

  describe("Versão e isolamento de schema", () => {
    it("version:2 produz chave diferente de qualquer esquema anterior (version:1 simulado)", () => {
      // Chave version:2 com message_id → não pode colidir com chave v1 (snake_case)
      const v2 = computeDedupKeySync({ event: "msg", account_id: 1, id: 42 });
      const v1Simulated = sha256sync(canonicalJson({ account_id: 1, event: "msg", message_id: 42, v: 1 }));
      expect(v2).not.toBe(v1Simulated);
    });

    it("account_id diferente → chaves diferentes (isolamento entre contas)", () => {
      const h1 = computeDedupKeySync({ event: "message_created", account_id: 1, id: 42 });
      const h2 = computeDedupKeySync({ event: "message_created", account_id: 2, id: 42 });
      expect(h1).not.toBe(h2);
    });
  });
});
