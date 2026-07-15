/**
 * T05 — Isolamento do Supabase Realtime
 *
 * Investiga se eventos de conta A chegam para usuários de conta B.
 *
 * A tabela chatwoot_events não tem coluna account_id filtrada na
 * subscription — todos os browsers recebem todos os eventos.
 *
 * Este teste:
 *  1. Audita a schema RLS atual via SQL
 *  2. Simula o comportamento do subscription sem filtro
 *  3. Demonstra que sem account_id na subscription todos recebem tudo
 *  4. Classifica como crítico ou hipotético com base em evidências
 */

import { describe, it, expect, afterAll } from "vitest";
import { newTrace, recordEvidence, printEvidenceSummary } from "./evidence-log";

const traceId = newTrace();
afterAll(() => printEvidenceSummary());

// ── SQL de auditoria (executar manualmente contra Supabase) ──────────────────
export const AUDIT_QUERIES = {
  checkRLS: `
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'chatwoot_events';
  `,

  checkPolicies: `
    SELECT policyname, cmd, roles, qual, with_check
    FROM pg_policies
    WHERE tablename = 'chatwoot_events'
    ORDER BY policyname;
  `,

  checkPublicationTables: `
    SELECT tablename
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime';
  `,

  checkColumnList: `
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'chatwoot_events'
    ORDER BY ordinal_position;
  `,

  checkAccountIdExists: `
    SELECT COUNT(*) AS has_account_id
    FROM information_schema.columns
    WHERE table_name = 'chatwoot_events'
    AND column_name = 'account_id';
  `,

  recentEvents: `
    SELECT id, event_type, account_id, conversation_id, created_at
    FROM public.chatwoot_events
    ORDER BY id DESC
    LIMIT 20;
  `,
};

// ── Lógica de subscription atual (extrai de index.tsx:392–397) ───────────────
type SubscriptionConfig = {
  event: string;
  schema: string;
  table: string;
  filter?: string;
};

const CURRENT_SUBSCRIPTION: SubscriptionConfig = {
  event: "INSERT",
  schema: "public",
  table: "chatwoot_events",
  // AUSÊNCIA DE FILTRO — não tem filter: `account_id=eq.${accountId}`
};

// ── Simulação de dois usuários recebendo eventos ──────────────────────────────
type RealtimeEvent = {
  event_type: string;
  account_id: number;
  conversation_id: number;
  content: string;
};

function wouldUserReceiveEvent(
  userAccountId: number,
  subscription: SubscriptionConfig,
  event: RealtimeEvent
): boolean {
  // Se subscription tem filter por account_id, aplica o filtro
  if (subscription.filter?.includes("account_id")) {
    const match = subscription.filter.match(/account_id=eq\.(\d+)/);
    if (match) {
      return parseInt(match[1]) === event.account_id;
    }
  }
  // Sem filtro → recebe tudo (comportamento atual)
  return true;
}

describe("T05 — Isolamento do Realtime por account_id", () => {
  describe("Auditoria estática da subscription", () => {
    it("Subscription atual não tem filtro por account_id", () => {
      const hasAccountFilter = Boolean(CURRENT_SUBSCRIPTION.filter?.includes("account_id"));

      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T05-subscription-filter",
        step: "Verificar filtro na subscription de chatwoot_events",
        status: hasAccountFilter ? "PASS" : "FAIL",
        assertion: "Subscription deve filtrar por account_id para isolar tenants",
        expected: "filter: 'account_id=eq.<user_account_id>'",
        actual: CURRENT_SUBSCRIPTION.filter ?? "(sem filtro)",
        error: !hasAccountFilter
          ? "BUG: Todos os usuários conectados recebem todos os eventos de todas as contas"
          : undefined,
        file: "src/routes/index.tsx",
        line: 392,
      });

      expect(hasAccountFilter).toBe(true); // RED TEST
    });

    it("Tabela chatwoot_events tem coluna account_id mas não é usada no filtro", () => {
      // A coluna existe (migration 20260629120000_chatwoot_events.sql linha 5)
      // mas não é usada no .on("postgres_changes", { filter: ... })
      const columnExistsInMigration = `
        CREATE TABLE IF NOT EXISTS public.chatwoot_events (
          account_id INTEGER,
        );
      `.includes("account_id");

      const usedInFilter = CURRENT_SUBSCRIPTION.filter?.includes("account_id") ?? false;

      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T05-account-id-column",
        step: "account_id existe na tabela mas não é usado como filtro Realtime",
        status: !columnExistsInMigration || usedInFilter ? "PASS" : "FAIL",
        assertion: "Se account_id existe, deve ser usado como filtro na subscription",
        expected: "filter: account_id=eq.<id>",
        actual: `account_id na tabela: ${columnExistsInMigration}, usado no filtro: ${usedInFilter}`,
        error: columnExistsInMigration && !usedInFilter
          ? "A coluna account_id existe mas não filtra a subscription — desperdício e risco de isolamento"
          : undefined,
      });

      expect(usedInFilter).toBe(true); // RED TEST
    });
  });

  describe("Matriz de isolamento — simulação", () => {
    const eventContaA: RealtimeEvent = {
      event_type: "message_created",
      account_id: 1,
      conversation_id: 101,
      content: "Mensagem da conta A",
    };

    const eventContaB: RealtimeEvent = {
      event_type: "message_created",
      account_id: 2,
      conversation_id: 201,
      content: "Mensagem da conta B",
    };

    it("Usuário A (account_id=1) recebe evento de conta A — esperado", () => {
      const receives = wouldUserReceiveEvent(1, CURRENT_SUBSCRIPTION, eventContaA);
      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T05-matrix",
        step: "Usuário A recebe evento de conta A",
        status: receives ? "PASS" : "FAIL",
        expected: true, actual: receives,
      });
      expect(receives).toBe(true);
    });

    it("Usuário B (account_id=2) NÃO deve receber evento de conta A — BUG: recebe", () => {
      const receives = wouldUserReceiveEvent(2, CURRENT_SUBSCRIPTION, eventContaA);

      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T05-matrix",
        step: "Usuário B recebe evento de conta A (não deveria)",
        status: !receives ? "PASS" : "FAIL",
        assertion: "Usuário B NÃO deve receber eventos da conta A",
        expected: false,
        actual: receives,
        error: receives
          ? "BUG CONFIRMADO (por simulação): sem filtro na subscription, " +
            "usuário B recebe eventos da conta A em tempo real"
          : undefined,
      });

      // Importante: este bug só é crítico se o sistema tiver múltiplas contas.
      // Com uma única conta (cenário atual), é risco latente.
      // Classificação: RISCO ARQUITETURAL CONFIRMADO — crítico em ambiente multi-tenant.
      expect(receives).toBe(false); // RED TEST
    });

    it("Usuário anônimo NÃO deve receber eventos via Realtime", () => {
      // A migration 20260713000000 adicionou SELECT para anon
      // Isso permite que qualquer browser sem sessão receba todos os eventos

      const anonHasSelectPolicy = true; // confirmado pela migration 20260713000000

      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T05-anon-realtime",
        step: "anon role pode fazer SELECT em chatwoot_events (migration 20260713000000)",
        status: anonHasSelectPolicy ? "FAIL" : "PASS",
        assertion: "anon NÃO deve ter SELECT em chatwoot_events",
        expected: "Apenas authenticated pode SELECT",
        actual: "anon tem SELECT (política adicionada para Realtime funcionar sem sessão)",
        error: anonHasSelectPolicy
          ? "RISCO: qualquer pessoa com a anon key do Supabase pode se inscrever e receber " +
            "todos os eventos de chatwoot_events em tempo real"
          : undefined,
        file: "supabase/migrations/20260713000000_chatwoot_events_anon_read.sql",
        line: 1,
      });

      expect(anonHasSelectPolicy).toBe(false); // RED TEST
    });
  });

  describe("RLS como defesa — verificação", () => {
    it("RLS com policy correta bloquearia SELECT direto de anon — mas Realtime bypassa RLS por default", () => {
      // Supabase Realtime usa postgres_changes com verificação de RLS
      // PORÉM: o filter na subscription é obrigatório para que o RLS funcione corretamente
      // com Realtime. Sem filter, o Supabase envia o evento se a policy de SELECT passar.

      // Dado que anon tem SELECT → anon recebe todos os eventos via Realtime
      // A defesa via RLS seria: account_id = auth.uid()... mas não há mapping direto

      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T05-rls-realtime",
        step: "RLS de SELECT para anon habilita Realtime sem restrição",
        status: "WARNING",
        assertion: "RLS SELECT para anon sem policy restritiva = Realtime sem isolamento",
        actual: "Policy atual: USING (true) para anon e authenticated — sem restrição por account_id",
        error: "Enquanto houver uma única conta, o impacto é baixo. " +
               "Em ambiente multi-tenant, este é um vazamento crítico de dados em tempo real.",
      });

      // Queries SQL para confirmar manualmente:
      console.log("\n── SQL DE AUDITORIA MANUAL ──────────────────────────────");
      for (const [name, sql] of Object.entries(AUDIT_QUERIES)) {
        console.log(`\n-- ${name}:`);
        console.log(sql.trim());
      }
      console.log("─────────────────────────────────────────────────────────\n");

      // Documenta: risco confirmado por análise estática, não demonstrado como explorado
      expect(true).toBe(true); // informativo
    });
  });

  describe("Matriz completa de isolamento", () => {
    const matrix = [
      { userAccount: 1, eventAccount: 1, shouldReceive: true,  label: "Evento conta A → Usuário A" },
      { userAccount: 2, eventAccount: 1, shouldReceive: false, label: "Evento conta A → Usuário B (não deve)" },
      { userAccount: 1, eventAccount: 2, shouldReceive: false, label: "Evento conta B → Usuário A (não deve)" },
      { userAccount: 2, eventAccount: 2, shouldReceive: true,  label: "Evento conta B → Usuário B" },
    ];

    for (const row of matrix) {
      it(row.label, () => {
        const event: RealtimeEvent = {
          event_type: "message_created",
          account_id: row.eventAccount,
          conversation_id: row.eventAccount * 100,
          content: `Evento de conta ${row.eventAccount}`,
        };

        const actuallyReceives = wouldUserReceiveEvent(row.userAccount, CURRENT_SUBSCRIPTION, event);
        const pass = actuallyReceives === row.shouldReceive;

        recordEvidence({
          traceId, timestamp: new Date().toISOString(),
          scenario: "T05-isolation-matrix",
          step: row.label,
          status: pass ? "PASS" : "FAIL",
          expected: row.shouldReceive,
          actual: actuallyReceives,
          accountId: row.userAccount,
          error: !pass ? `ISOLAMENTO VIOLADO: ${row.label}` : undefined,
        });

        expect(actuallyReceives).toBe(row.shouldReceive);
      });
    }
  });
});
