import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Bell, ChevronDown, Moon, Sun } from "lucide-react";
import { BerryLogo } from "./BerryLogo";
import { supabase } from "@/integrations/supabase/client";
import { initialsOf, cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type AgentStatus = "online" | "away" | "offline";
const statusColor: Record<AgentStatus, string> = {
  online: "#00e186",
  away: "#f59e0b",
  offline: "#d1d5db",
};
const statusLabel: Record<AgentStatus, string> = {
  online: "Online",
  away: "Ausente",
  offline: "Offline",
};

const ALL_NAV_ITEMS = [
  { to: "/", label: "Atendimento", adminOnly: false },
  { to: "/gestao", label: "Gestor", adminOnly: true },
  { to: "/ligacoes", label: "Ligações", adminOnly: false },
  { to: "/contatos", label: "Contatos", adminOnly: false },
  { to: "/templates", label: "Templates", adminOnly: false },
  { to: "/configuracoes", label: "Configurações", adminOnly: true },
] as const;

export function AppHeader() {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { theme, toggleTheme } = useTheme();
  const [agent, setAgent] = useState<{ name: string; status: AgentStatus; role: string } | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const { data } = await supabase
        .from("agents")
        .select("name, status, role")
        .eq("id", u.user.id)
        .maybeSingle();
      if (active && data)
        setAgent({ name: data.name, status: (data.status as AgentStatus) || "online", role: data.role ?? "agent" });
    })();
    return () => { active = false; };
  }, []);

  async function changeStatus(next: AgentStatus) {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    await supabase.from("agents").update({ status: next }).eq("id", u.user.id);
    setAgent((a) => (a ? { ...a, status: next } : a));
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.navigate({ to: "/login" });
  }

  return (
    <header
      className="flex items-center justify-between px-6"
      style={{ background: "#090909", height: 52 }}
    >
      <div className="flex items-center gap-8">
        <Link to="/" className="flex items-center">
          <BerryLogo height={22} white />
        </Link>
        <nav className="flex items-center gap-6">
          {ALL_NAV_ITEMS
            .filter((item) => !item.adminOnly || agent?.role === "admin")
            .map((item) => {
              const active =
                item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    "text-sm transition-opacity",
                    active ? "text-white font-semibold" : "text-white/80 hover:text-white"
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
        </nav>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={toggleTheme}
          className="rounded-md p-2 text-white/80 hover:bg-white/5 hover:text-white"
          title={theme === "dark" ? "Modo claro" : "Modo escuro"}
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
        <button className="rounded-md p-2 text-white/80 hover:bg-white/5 hover:text-white">
          <Bell className="h-4 w-4" />
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2 rounded-md px-2 py-1 text-white hover:bg-white/5">
              <span
                className="block h-2 w-2 rounded-full"
                style={{ background: statusColor[agent?.status ?? "online"] }}
              />
              <span className="text-sm">{agent?.name ?? "Agente"}</span>
              <div
                className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold"
                style={{ background: "#00e186", color: "#090909" }}
              >
                {initialsOf(agent?.name)}
              </div>
              <ChevronDown className="h-3.5 w-3.5 text-white/60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {(["online", "away", "offline"] as AgentStatus[]).map((s) => (
              <DropdownMenuItem key={s} onClick={() => changeStatus(s)}>
                <span
                  className="mr-2 inline-block h-2 w-2 rounded-full"
                  style={{ background: statusColor[s] }}
                />
                {statusLabel[s]}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={signOut}>Sair</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
