-- ── Migration: feature_flags + dedup v2 ──────────────────────────────────────
--
-- ATENÇÃO: NÃO aplicar em produção até aprovação explícita.
-- Esta migration adiciona:
--   1. Tabela feature_flags (kill switch sem redeploy)
--   2. Garante que chatwoot_events.dedup_key suporta o esquema v2
--   3. Índice parcial na nova coluna message_id (para dedup eficiente)
--
-- Rollback: ver seção de ROLLBACK ao final deste arquivo.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Tabela feature_flags ───────────────────────────────────────────────────
-- Somente service role pode escrever.
-- Frontend lê com anon key (RLS SELECT para autenticados).

CREATE TABLE IF NOT EXISTS feature_flags (
  flag_name          text          PRIMARY KEY,
  enabled            boolean       NOT NULL DEFAULT false,
  enabled_for_users  uuid[]        NOT NULL DEFAULT '{}',
  description        text,
  updated_at         timestamptz   NOT NULL DEFAULT now()
);

-- Seed: flags desabilitadas por padrão
INSERT INTO feature_flags (flag_name, enabled, description)
VALUES
  ('FEATURE_CONVERSATION_CACHE', false, 'Cache de conversas no IndexedDB (Etapa 3)'),
  ('FEATURE_MESSAGE_CACHE',      false, 'Cache de mensagens no IndexedDB (Etapa 4)')
ON CONFLICT (flag_name) DO NOTHING;

-- RLS
ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;

-- Agentes autenticados podem LER (para verificar flags)
CREATE POLICY "feature_flags_read_authenticated"
  ON feature_flags
  FOR SELECT
  TO authenticated
  USING (true);

-- Nenhum agente comum pode escrever — somente service role (via backend/Edge Function)
-- (service role bypassa RLS)

-- ── 2. chatwoot_events — suporte ao dedup_key v2 ─────────────────────────────
-- O campo dedup_key já existe (migration 20260629120000).
-- Aqui garantimos que o índice UNIQUE EXISTS e está correto.
-- O Edge Function já gera chaves v2 com JSON.stringify canônico.

-- Adicionar coluna message_id para facilitar queries (opcional, melhora diagnóstico)
ALTER TABLE chatwoot_events
  ADD COLUMN IF NOT EXISTS message_id bigint;

-- Índice para lookups eficientes por message_id
CREATE INDEX IF NOT EXISTS chatwoot_events_message_id_idx
  ON chatwoot_events (message_id)
  WHERE message_id IS NOT NULL;

-- Confirmar índice UNIQUE em dedup_key (pode já existir)
-- Usamos CREATE UNIQUE INDEX IF NOT EXISTS para ser idempotente
CREATE UNIQUE INDEX IF NOT EXISTS chatwoot_events_dedup_key_unique
  ON chatwoot_events (dedup_key)
  WHERE dedup_key IS NOT NULL;

-- ── 3. Comentários de auditoria ───────────────────────────────────────────────

COMMENT ON TABLE feature_flags IS
  'Kill-switch por flag e por usuário. Somente service role pode escrever. '
  'Frontend lê com anon key. Não editável por agentes da interface.';

COMMENT ON COLUMN chatwoot_events.message_id IS
  'ID da mensagem Chatwoot (payload.id). Populado pelo Edge Function. '
  'Usado para diagnóstico de deduplicação v2.';

-- ── ROLLBACK ──────────────────────────────────────────────────────────────────
-- Para desfazer esta migration:
--
-- DROP INDEX IF EXISTS chatwoot_events_dedup_key_unique;
-- DROP INDEX IF EXISTS chatwoot_events_message_id_idx;
-- ALTER TABLE chatwoot_events DROP COLUMN IF EXISTS message_id;
-- DROP TABLE IF EXISTS feature_flags;
--
-- O Edge Function continuará funcionando após rollback:
--   - dedup_key ainda é inserido (mesmo sem índice UNIQUE redundante)
--   - feature_flags ausente → frontend usa defaults (false) via fallback silencioso
