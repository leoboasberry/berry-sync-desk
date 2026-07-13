-- Allow anon users to receive chatwoot_events via Supabase Realtime
-- The browser client uses the anon key without a Supabase Auth session
CREATE POLICY "anon users can read chatwoot_events"
  ON public.chatwoot_events FOR SELECT
  TO anon
  USING (true);
