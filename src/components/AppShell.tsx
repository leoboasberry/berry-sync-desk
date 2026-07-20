import { useEffect, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { getSettingsConfigured } from "@/lib/chatwoot.functions";
import { AppHeader } from "./AppHeader";
import { Button } from "@/components/ui/button";
import { Settings as SettingsIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";

export function AppShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (!data.session) {
        navigate({ to: "/login" });
      } else {
        setReady(true);
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!session) navigate({ to: "/login" });
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [navigate]);

  useEffect(() => {
    (async () => {
      // Uses server function — tokens never reach the browser.
      const result = await getSettingsConfigured({}).catch(() => null);
      const missing = !result || (!result.chatwootConfigured && !result.hubspotConfigured);
      setNeedsSetup(missing);
    })();
  }, [pathname]);

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white dark:bg-[#1a1a1a]">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#00e186] border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-white dark:bg-[#1a1a1a]">
      <AppHeader />
      {needsSetup && pathname !== "/configuracoes" && (
        <div className="flex items-center justify-between border-b border-[#e5e5e5] dark:border-[#2a2a2a] bg-[#fff8e1] dark:bg-[#2a1800] px-6 py-2.5 text-sm text-[#090909] dark:text-[#e8e8e8]">
          <span>Configure as integrações para começar.</span>
          <Button asChild size="sm" className="bg-[#090909] text-white hover:bg-[#090909]/90">
            <Link to="/configuracoes">
              <SettingsIcon className="mr-1.5 h-3.5 w-3.5" />
              Configurar
            </Link>
          </Button>
        </div>
      )}
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
