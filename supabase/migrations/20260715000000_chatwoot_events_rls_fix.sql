-- B07: Remove anon SELECT — browsers sem sessão Supabase Auth não podem receber eventos
-- B06 (parcial): Restringe authenticated a usuários que existem em agents (tenant check)
--
-- Proteção principal: RLS no banco
-- Proteção secundária: filter na subscription do cliente (index.tsx)
-- Edge Function usa service_role — bypassa RLS (correto, não é afetada)

-- Remove política anon irrestrita
DROP POLICY IF EXISTS "anon users can read chatwoot_events" ON public.chatwoot_events;

-- Remove política authenticated irrestrita
DROP POLICY IF EXISTS "authenticated users can read chatwoot_events" ON public.chatwoot_events;

-- Nova política: apenas agentes cadastrados podem ler eventos
-- USING: o auth.uid() deve existir na tabela agents
CREATE POLICY "agents can read chatwoot_events"
  ON public.chatwoot_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.agents
      WHERE id = auth.uid()
    )
  );

-- Garante que anon não tem SELECT (revoga grant se existir)
REVOKE SELECT ON public.chatwoot_events FROM anon;

-- Nota: service_role bypassa RLS — Edge Function continua inserindo normalmente
-- INSERT/UPDATE/DELETE para authenticated continuam disponíveis (grants existentes)
-- Mas não há política de INSERT/UPDATE/DELETE para authenticated → bloqueados por RLS
-- Isso é intencional: só a Edge Function (service_role) pode inserir eventos
