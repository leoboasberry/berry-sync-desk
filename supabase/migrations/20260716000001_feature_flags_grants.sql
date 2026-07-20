-- Correção: adiciona GRANTs de tabela para feature_flags.
-- A migration anterior criou a RLS policy mas não o privilégio base de SELECT.
-- service_role precisa de ALL para poder fazer seed/update via Edge Function.
-- authenticated precisa de SELECT para o frontend ler as flags.

GRANT SELECT ON feature_flags TO authenticated;
GRANT ALL    ON feature_flags TO service_role;
