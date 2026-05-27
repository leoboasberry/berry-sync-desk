
-- agents
CREATE TABLE public.agents (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'online',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agents TO authenticated;
GRANT ALL ON public.agents TO service_role;
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agents read all" ON public.agents FOR SELECT TO authenticated USING (true);
CREATE POLICY "agents insert self" ON public.agents FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY "agents update self" ON public.agents FOR UPDATE TO authenticated USING (auth.uid() = id);

-- call_logs
CREATE TABLE public.call_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_name text,
  contact_phone text,
  agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  hubspot_contact_id text,
  duration_seconds integer DEFAULT 0,
  status text DEFAULT 'completed',
  recording_url text,
  transcript text,
  ai_summary text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_logs TO authenticated;
GRANT ALL ON public.call_logs TO service_role;
ALTER TABLE public.call_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "call_logs read all" ON public.call_logs FOR SELECT TO authenticated USING (true);
CREATE POLICY "call_logs insert" ON public.call_logs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "call_logs update" ON public.call_logs FOR UPDATE TO authenticated USING (true);

-- settings (single row)
CREATE TABLE public.settings (
  id integer PRIMARY KEY DEFAULT 1,
  chatwoot_url text,
  chatwoot_account_id text,
  chatwoot_token text,
  hubspot_token text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settings_singleton CHECK (id = 1)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.settings TO authenticated;
GRANT ALL ON public.settings TO service_role;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "settings read" ON public.settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "settings upsert" ON public.settings FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "settings update" ON public.settings FOR UPDATE TO authenticated USING (true);
INSERT INTO public.settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- hubspot_cache
CREATE TABLE public.hubspot_cache (
  phone text PRIMARY KEY,
  contact_data jsonb,
  deal_data jsonb,
  cached_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hubspot_cache TO authenticated;
GRANT ALL ON public.hubspot_cache TO service_role;
ALTER TABLE public.hubspot_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hubspot_cache read" ON public.hubspot_cache FOR SELECT TO authenticated USING (true);
CREATE POLICY "hubspot_cache insert" ON public.hubspot_cache FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "hubspot_cache update" ON public.hubspot_cache FOR UPDATE TO authenticated USING (true);

-- Trigger to auto-create agent on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.agents (id, name, email, status)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    NEW.email,
    'online'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.call_logs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.agents;
