// Brazilian phone normalization and validation.
// Single source of truth — used by both client (index.tsx) and server (chatwoot.functions.ts).
//
// Accepted formats:
//   13 digits: 55 + 2-digit DDD + 9-digit mobile  → returned as-is
//   12 digits: 55 + 2-digit DDD + 8-digit landline → accepted without modification
//
// The 9-digit-insertion heuristic is intentionally absent: an 8-digit number may be
// a valid landline and must never be silently altered.

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

export interface PhoneValidation {
  normalized: string | null;
  error: string | null;
  // Present when the number is valid but unusual (e.g. looks like a landline).
  // Never blocks submission — the caller decides whether to surface it.
  warning?: string;
}

export function validateBrazilianPhone(raw: string): PhoneValidation {
  if (!raw || !raw.trim()) {
    return { normalized: null, error: "Telefone obrigatório." };
  }

  let d = raw.replace(/\D/g, "");

  // Remove leading zero (0 before DDD or country code)
  if (d.startsWith("0")) d = d.slice(1);

  // Strip duplicated country code: "5555..." where the second block is also 55
  if (d.startsWith("55")) {
    const rest = d.slice(2);
    if (rest.startsWith("55") && rest.length >= 10) {
      d = rest;
    }
  }

  // Add country code if absent
  if (!d.startsWith("55")) d = "55" + d;

  // Accept 12 (landline) or 13 (mobile) digits — never add or remove digits.
  if (d.length !== 12 && d.length !== 13) {
    const localDigits = d.length - 2;
    return {
      normalized: null,
      error: `Número inválido: esperados 8 ou 9 dígitos após o DDD, recebidos ${localDigits}.`,
    };
  }

  const ddd = parseInt(d.slice(2, 4), 10);
  if (!VALID_DDDS.has(ddd)) {
    return { normalized: null, error: `DDD ${ddd} não é válido.` };
  }

  // Informational only — 8-digit numbers may be valid landlines.
  const warning =
    d.length === 12
      ? "Este número possui 8 dígitos — pode ser telefone fixo ou estar faltando o nono dígito."
      : undefined;

  return { normalized: d, error: null, warning };
}

// Format a normalized phone for human display.
// 12-digit (landline): 5511XXXXXXXX  → +55 11 XXXX-XXXX
// 13-digit (mobile):   5511XXXXXXXXX → +55 11 XXXXX-XXXX
export function formatBrazilianPhone(normalized: string): string {
  const ddd = normalized.slice(2, 4);
  const num = normalized.slice(4);
  if (normalized.length === 13) {
    return `+55 ${ddd} ${num.slice(0, 5)}-${num.slice(5)}`;
  }
  if (normalized.length === 12) {
    return `+55 ${ddd} ${num.slice(0, 4)}-${num.slice(4)}`;
  }
  return normalized;
}
