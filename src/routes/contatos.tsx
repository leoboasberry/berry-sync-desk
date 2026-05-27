import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Input } from "@/components/ui/input";
import { initialsOf } from "@/lib/utils";
import { Search, Users } from "lucide-react";

export const Route = createFileRoute("/contatos")({
  head: () => ({ meta: [{ title: "Contatos — Berry" }] }),
  component: () => (
    <AppShell>
      <ContatosPage />
    </AppShell>
  ),
});

// Placeholder until HubSpot token configured. Search will call /crm/v3/objects/contacts/search.
const sample = [
  { name: "Marina Souza", company: "Franquia SP Centro", phone: "+55 11 99876-1234", deal: "Renovação 2026", stage: "Proposta", last: "3 min" },
  { name: "Rafael Lima", company: "Franquia RJ Tijuca", phone: "+55 21 98765-4321", deal: "Expansão unidade", stage: "Negociação", last: "45 min" },
  { name: "Camila Andrade", company: "Franquia BH", phone: "+55 31 99654-7890", deal: "Treinamento Q1", stage: "Fechado", last: "3h" },
];

function ContatosPage() {
  const [q, setQ] = useState("");
  const filtered = sample.filter(
    (c) =>
      c.name.toLowerCase().includes(q.toLowerCase()) ||
      c.company.toLowerCase().includes(q.toLowerCase())
  );

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      <h1 className="mb-6 text-[22px] font-bold text-[#090909]">Contatos</h1>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#666]" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar por nome, empresa ou telefone…"
          className="h-11 pl-10"
        />
      </div>

      <div className="overflow-hidden rounded-[10px] border border-[#e5e5e5] bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-[#e5e5e5] bg-[#f8f8f8]">
            <tr>
              <Th>Nome</Th>
              <Th>Empresa</Th>
              <Th>Telefone</Th>
              <Th>Deal ativo</Th>
              <Th>Stage</Th>
              <Th>Último contato</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-16 text-center text-[#666]">
                  <Users className="mx-auto mb-3 h-10 w-10 text-[#c0c0c0]" />
                  Nenhum contato encontrado.
                </td>
              </tr>
            ) : (
              filtered.map((c) => (
                <tr
                  key={c.phone}
                  className="cursor-pointer border-b border-[#e5e5e5] last:border-0 hover:bg-[#fafafa]"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div
                        className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold"
                        style={{ background: "#00e186", color: "#090909" }}
                      >
                        {initialsOf(c.name)}
                      </div>
                      <span className="font-medium text-[#090909]">{c.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[#090909]">{c.company}</td>
                  <td className="px-4 py-3 text-[#666]">{c.phone}</td>
                  <td className="px-4 py-3 text-[#090909]">{c.deal}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-[#f0f0f0] px-2 py-0.5 text-[11px] font-medium text-[#444]">
                      {c.stage}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[#666]">{c.last} atrás</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-[#666]">
      {children}
    </th>
  );
}
