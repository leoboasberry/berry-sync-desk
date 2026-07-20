-- Isolamento real por account_id — B07 v2
--
-- Problema com B07 v1 (20260715000000):
--   USING (EXISTS (SELECT 1 FROM agents WHERE id = auth.uid()))
--   → qualquer agente cadastrado lê eventos de qualquer conta
--   → não há ligação entre agente e chatwoot_account_id
--
-- Solução: tabela agent_accounts como vínculo explícito.
-- A policy usa este vínculo para restringir por linha.
--
-- ── Tabela de vínculo ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.agent_accounts (
  user_id              uuid    NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  chatwoot_account_id  bigint  NOT NULL,
  role                 text    NOT NULL DEFAULT 'agent'
                       CHECK (role IN ('agent', 'admin')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, chatwoot_account_id)
);

GRANT SELECT ON public.agent_accounts TO authenticated;
GRANT ALL    ON public.agent_accounts TO service_role;

ALTER TABLE public.agent_accounts ENABLE ROW LEVEL SECURITY;

-- Agentes podem ver seus próprios vínculos
CREATE POLICY "agent_accounts self read"
  ON public.agent_accounts FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Somente service_role pode inserir/alterar vínculos (server functions)
-- Sem INSERT/UPDATE/DELETE policy para authenticated → bloqueado por RLS

-- ── Backfill seguro ──────────────────────────────────────────────────────────
-- 1. Lê o account_id atual de settings (tipo TEXT → BIGINT)
-- 2. Valida que é um número positivo
-- 3. Insere vínculo para todos os agentes existentes
-- 4. Aborta se account_id ausente ou inválido

DO $$
DECLARE
  v_account_id_text TEXT;
  v_account_id      BIGINT;
  v_agent_count     INT;
  v_inserted        INT;
BEGIN
  -- 1. Lê account_id
  SELECT chatwoot_account_id INTO v_account_id_text
  FROM public.settings
  WHERE id = 1;

  IF v_account_id_text IS NULL OR trim(v_account_id_text) = '' THEN
    RAISE EXCEPTION
      'BACKFILL ABORTADO: settings.chatwoot_account_id está vazio. '
      'Configure o account_id no Chatwoot antes de aplicar esta migration.';
  END IF;

  -- 2. Valida que é um inteiro positivo
  BEGIN
    v_account_id := v_account_id_text::BIGINT;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'BACKFILL ABORTADO: chatwoot_account_id "%" não é um inteiro válido.',
      v_account_id_text;
  END;

  IF v_account_id <= 0 THEN
    RAISE EXCEPTION
      'BACKFILL ABORTADO: chatwoot_account_id deve ser positivo, mas é %.',
      v_account_id;
  END IF;

  -- 3. Conta agentes existentes
  SELECT COUNT(*) INTO v_agent_count FROM public.agents;

  RAISE NOTICE 'Backfill: account_id=%, agentes encontrados=%', v_account_id, v_agent_count;

  -- 4. Insere vínculos (ON CONFLICT = idempotente)
  INSERT INTO public.agent_accounts (user_id, chatwoot_account_id, role)
  SELECT
    a.id,
    v_account_id,
    COALESCE(a.role, 'agent')
  FROM public.agents a
  ON CONFLICT (user_id, chatwoot_account_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  RAISE NOTICE 'Backfill concluído: % vínculos inseridos (% já existiam)',
    v_inserted, v_agent_count - v_inserted;

  -- 5. Valida contagem final
  IF v_inserted = 0 AND v_agent_count > 0 THEN
    RAISE NOTICE 'Todos os vínculos já existiam — migration é idempotente.';
  END IF;

END $$;

-- ── Substitui a policy de chatwoot_events ────────────────────────────────────

-- Remove policy v1 (verifica apenas existência em agents)
DROP POLICY IF EXISTS "agents can read chatwoot_events" ON public.chatwoot_events;

-- Nova policy: verifica vínculo explícito com o account_id DA LINHA
CREATE POLICY "agent_accounts can read chatwoot_events"
  ON public.chatwoot_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.agent_accounts aa
      WHERE aa.user_id = auth.uid()
        AND aa.chatwoot_account_id = chatwoot_events.account_id
    )
  );

-- ── Queries de verificação ────────────────────────────────────────────────────
-- Executar após aplicar para confirmar:
--
-- 1. Contar vínculos criados:
--    SELECT COUNT(*) FROM public.agent_accounts;
--    -- Deve ser igual ao número de agentes
--
-- 2. Listar vínculos:
--    SELECT aa.user_id, a.name, a.email, aa.chatwoot_account_id, aa.role
--    FROM public.agent_accounts aa JOIN public.agents a ON a.id = aa.user_id;
--
-- 3. Confirmar policy ativa:
--    SELECT policyname, cmd, qual
--    FROM pg_policies
--    WHERE tablename = 'chatwoot_events';
--    -- Deve mostrar apenas "agent_accounts can read chatwoot_events"
--
-- 4. Testar isolamento (substituir pelos UUIDs reais):
--    SET LOCAL role TO authenticated;
--    SET LOCAL "request.jwt.claims" TO '{"sub":"<uuid-agente-A>"}';
--    SELECT COUNT(*) FROM chatwoot_events WHERE account_id = <conta-A>;  -- deve retornar > 0
--    SELECT COUNT(*) FROM chatwoot_events WHERE account_id = <conta-B>;  -- deve retornar 0

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- DROP POLICY IF EXISTS "agent_accounts can read chatwoot_events" ON public.chatwoot_events;
-- CREATE POLICY "agents can read chatwoot_events"
--   ON public.chatwoot_events FOR SELECT TO authenticated
--   USING (EXISTS (SELECT 1 FROM public.agents WHERE id = auth.uid()));
-- DROP TABLE IF EXISTS public.agent_accounts;
