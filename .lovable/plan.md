
# Migration SQL completa para Supabase próprio

Vou gerar um único arquivo `supabase-migration.sql` em `/mnt/documents/` que você roda no SQL Editor do seu Supabase próprio (ou via `psql`). Ele recria todo o backend atual deste projeto.

## O que o SQL vai conter

1. **Tabela `agents`** (espelha `auth.users`)
   - Colunas: `id` (uuid PK), `name`, `email`, `status`, `created_at`
   - GRANTs para `authenticated` e `service_role`
   - RLS habilitada + policies:
     - `agents read all` (SELECT, authenticated, `true`)
     - `agents insert self` (INSERT, `auth.uid() = id`)
     - `agents update self` (UPDATE, `auth.uid() = id`)

2. **Tabela `settings`** (singleton id=1, credenciais Chatwoot/HubSpot)
   - Colunas: `id` (int PK default 1), `chatwoot_url`, `chatwoot_account_id`, `chatwoot_token`, `hubspot_token`, `updated_at`
   - GRANTs + RLS + policies de SELECT/INSERT/UPDATE para `authenticated`

3. **Tabela `call_logs`**
   - Colunas: `id` (uuid PK), `agent_id` (FK → agents), `contact_name`, `contact_phone`, `hubspot_contact_id`, `duration_seconds`, `status`, `recording_url`, `transcript`, `ai_summary`, `created_at`
   - GRANTs + RLS + policies de SELECT/INSERT/UPDATE para `authenticated`

4. **Tabela `hubspot_cache`**
   - Colunas: `phone` (text PK), `contact_data` (jsonb), `deal_data` (jsonb), `cached_at`
   - GRANTs + RLS + policies de SELECT/INSERT/UPDATE para `authenticated`

5. **Function `public.handle_new_user()`** (SECURITY DEFINER)
   - Insere uma linha em `agents` toda vez que um usuário é criado em `auth.users`, usando `raw_user_meta_data.name` ou a parte do e-mail antes do `@`.

6. **Trigger `on_auth_user_created`** em `auth.users AFTER INSERT` chamando `handle_new_user()`.

## Instruções de uso (vou incluir como comentário no topo do arquivo)

- Abra **SQL Editor** no painel do seu Supabase → **New query** → cole o conteúdo → **Run**.
- Depois conecte o Lovable a esse projeto pelo botão **Supabase** no topo direito; os secrets `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` serão substituídos automaticamente.
- O arquivo é **idempotente** onde possível (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP POLICY IF EXISTS` antes de cada `CREATE POLICY`, `DROP TRIGGER IF EXISTS` antes do `CREATE TRIGGER`) — pode rodar várias vezes sem erro.

## O que **não** vai junto (e por quê)

- **Dados** das tabelas atuais (settings, call_logs, etc.) — migration é só schema. Se quiser exportar os dados depois, me avise.
- **Secrets do Lovable Cloud** (`LOVABLE_API_KEY`) — não pertencem ao seu Supabase; ficam no painel de secrets do Lovable.
- Configuração de **Auth providers** (Google, etc.) — feita pela UI do Supabase, não por SQL.

## Entregável

Ao implementar, eu gero o arquivo e te entrego via tag `<presentation-artifact>` para você baixar.
