// Brazilian WhatsApp phone normalization and validation.
// Single source of truth — used by both client (index.tsx) and server (chatwoot.functions.ts).
// normalized output: 13 digits, no +, no spaces: 55 + DDD + 9-digit mobile.

const VALID_DDDS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24,
  27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46,
  47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77,
  79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

export function validateBrazilianPhone(raw: string): { normalized: string | null; error: string | null } {
  if (!raw || !raw.trim()) {
    return { normalized: null, error: "Telefone obrigatório." };
  }

  let d = raw.replace(/\D/g, "");

  // Remove leading zero (common typo: 0 before DDD or country code)
  if (d.startsWith("0")) d = d.slice(1);

  // Detect duplicated country code: "5555..." where the second block is also 55
  if (d.startsWith("55")) {
    const rest = d.slice(2);
    if (rest.startsWith("55") && rest.length >= 11) {
      d = rest;
    }
  }

  // Add country code if not present
  if (!d.startsWith("55")) d = "55" + d;

  // Old 8-digit mobile (12 digits total = 55 + 2 DDD + 8 number) → insert leading 9
  if (d.length === 12) {
    d = d.slice(0, 4) + "9" + d.slice(4);
  }

  if (d.length !== 13) {
    const userDigits = d.length - 2;
    return {
      normalized: null,
      error: `Número inválido: esperados 11 dígitos (DDD + celular), recebidos ${userDigits}.`,
    };
  }

  const ddd = parseInt(d.slice(2, 4), 10);
  if (!VALID_DDDS.has(ddd)) {
    return { normalized: null, error: `DDD ${ddd} não é válido.` };
  }

  if (d[4] !== "9") {
    return {
      normalized: null,
      error: "Número não parece ser celular (deve começar com 9 após o DDD).",
    };
  }

  return { normalized: d, error: null };
}

// Format canonical phone for human display: 5565999231672 → +55 65 99923-1672
export function formatBrazilianPhone(normalized: string): string {
  if (normalized.length !== 13) return normalized;
  const ddd = normalized.slice(2, 4);
  const num = normalized.slice(4);
  return `+55 ${ddd} ${num.slice(0, 5)}-${num.slice(5)}`;
}
