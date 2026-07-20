-- Proteger tabela settings contra escrita por agentes comuns
--
-- Problema atual:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON settings TO authenticated;
--   CREATE POLICY "settings update" USING (true);
--   → qualquer agente autenticado pode alterar chatwoot_account_id, tokens, etc.
--
-- Solução:
--   1. Revogar INSERT/UPDATE/DELETE de authenticated
--   2. Manter SELECT apenas para campos não-sensíveis via view
--   3. Escrita passa exclusivamente por server functions (service_role)
--
-- Campos sensíveis que NÃO devem ser retornados ao browser:
--   - chatwoot_token  (API access token do Chatwoot)
--   - hubspot_token   (Private App token do HubSpot)
--
-- Campos que o browser precisa ler diretamente:
--   - chatwoot_account_id  (usado na subscription Realtime do cliente)
--   - chatwoot_url         (não é segredo, mas não precisa ser exposto via REST)
--
-- O AppShell.tsx lê chatwoot_token e hubspot_token para verificar "needsSetup".
-- Isso deve ser substituído por uma server function que retorna apenas um booleano.

-- 1. Revogar privilégios de escrita de authenticated
REVOKE INSERT ON public.settings FROM authenticated;
REVOKE UPDATE ON public.settings FROM authenticated;
REVOKE DELETE ON public.settings FROM authenticated;

-- 2. Remover policies de escrita para authenticated
DROP POLICY IF EXISTS "settings upsert" ON public.settings;
DROP POLICY IF EXISTS "settings update" ON public.settings;

-- 3. Manter SELECT mas restringir a agentes cadastrados
DROP POLICY IF EXISTS "settings read" ON public.settings;

CREATE POLICY "settings read for agents"
  ON public.settings
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.agents WHERE id = auth.uid())
  );

-- 4. Criar view para o browser que EXCLUI campos sensíveis
--    O frontend lê apenas o necessário para funcionar sem tokens
CREATE OR REPLACE VIEW public.settings_public AS
  SELECT
    id,
    chatwoot_url,
    chatwoot_account_id,
    updated_at
  FROM public.settings;

-- Permissão de leitura da view para agentes autenticados
GRANT SELECT ON public.settings_public TO authenticated;

-- 5. service_role mantém acesso total (Edge Functions + server functions usam service_role)
-- GRANT ALL já existe para service_role — não precisa de alteração

-- ── Rollback (executar manualmente se necessário) ──────────────────────────
-- GRANT INSERT, UPDATE, DELETE ON public.settings TO authenticated;
-- CREATE POLICY "settings upsert" ON public.settings FOR INSERT TO authenticated WITH CHECK (true);
-- CREATE POLICY "settings update" ON public.settings FOR UPDATE TO authenticated USING (true);
-- DROP POLICY IF EXISTS "settings read for agents" ON public.settings;
-- CREATE POLICY "settings read" ON public.settings FOR SELECT TO authenticated USING (true);
-- DROP VIEW IF EXISTS public.settings_public;
