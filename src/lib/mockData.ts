// Mock conversations and messages used when Chatwoot integration isn't configured yet.
// These render realistic UI while real wiring is set up via Configurações.
export type MockConversation = {
  id: number;
  contact: { name: string; phone: string; email?: string; company?: string };
  preview: string;
  unread: boolean;
  updatedAt: string;
  status: "open" | "pending" | "resolved";
  messages: { id: number; from: "contact" | "agent"; text: string; at: string }[];
};

const now = Date.now();
const min = (m: number) => new Date(now - m * 60_000).toISOString();

export const mockConversations: MockConversation[] = [
  {
    id: 1,
    contact: { name: "Marina Souza", phone: "+55 11 99876-1234", email: "marina@franquia.com", company: "Franquia SP Centro" },
    preview: "Pode me confirmar o horário do treinamento de amanhã?",
    unread: true,
    updatedAt: min(3),
    status: "open",
    messages: [
      { id: 1, from: "contact", text: "Oi! Tudo bem?", at: min(15) },
      { id: 2, from: "agent", text: "Olá Marina, tudo ótimo! Como posso ajudar?", at: min(13) },
      { id: 3, from: "contact", text: "Pode me confirmar o horário do treinamento de amanhã?", at: min(3) },
    ],
  },
  {
    id: 2,
    contact: { name: "Rafael Lima", phone: "+55 21 98765-4321", company: "Franquia RJ Tijuca" },
    preview: "Recebi a proposta, vou analisar.",
    unread: false,
    updatedAt: min(45),
    status: "open",
    messages: [
      { id: 1, from: "agent", text: "Boa tarde, segue a proposta solicitada.", at: min(60) },
      { id: 2, from: "contact", text: "Recebi a proposta, vou analisar.", at: min(45) },
    ],
  },
  {
    id: 3,
    contact: { name: "Camila Andrade", phone: "+55 31 99654-7890", company: "Franquia BH" },
    preview: "Perfeito, podemos seguir.",
    unread: false,
    updatedAt: min(180),
    status: "pending",
    messages: [
      { id: 1, from: "contact", text: "Perfeito, podemos seguir.", at: min(180) },
    ],
  },
  {
    id: 4,
    contact: { name: "Diego Martins", phone: "+55 47 99123-8765" },
    preview: "Obrigado pelo atendimento!",
    unread: false,
    updatedAt: min(1440),
    status: "resolved",
    messages: [
      { id: 1, from: "contact", text: "Obrigado pelo atendimento!", at: min(1440) },
    ],
  },
];
