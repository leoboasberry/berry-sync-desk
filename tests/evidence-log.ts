/**
 * Coleta estruturada de evidências para cada caso de teste.
 * Cada evidência tem correlation_id e todos os IDs relevantes.
 */

import { randomUUID } from "crypto";
import { maskPhone, maskToken } from "./safety";

export type EvidenceEntry = {
  traceId: string;
  timestamp: string;
  scenario: string;
  step: string;
  // Identifiers
  conversationIdRequested?: number;
  conversationIdReturned?: number;
  conversationIdActive?: number;
  conversationIdRendered?: number;
  contactIdExpected?: number;
  contactIdActual?: number;
  accountId?: number;
  inboxId?: number;
  // Event context
  eventType?: string;
  messageType?: string;
  eventConversationId?: number;
  // State before/after
  stateBefore?: unknown;
  stateAfter?: unknown;
  activeTabBefore?: string;
  activeTabAfter?: string;
  // Result
  status: "PASS" | "FAIL" | "WARNING" | "INFO";
  assertion?: string;
  actual?: unknown;
  expected?: unknown;
  error?: string;
  // Timing
  requestStartedAt?: string;
  requestFinishedAt?: string;
  durationMs?: number;
  // Source
  file?: string;
  line?: number;
};

const log: EvidenceEntry[] = [];

export function newTrace(): string {
  return randomUUID();
}

export function recordEvidence(entry: EvidenceEntry): void {
  log.push(entry);
  const icon = entry.status === "PASS" ? "✅" :
               entry.status === "FAIL" ? "❌" :
               entry.status === "WARNING" ? "⚠️" : "ℹ️";

  console.log(
    `${icon} [${entry.traceId.slice(0, 8)}] [${entry.scenario}] ${entry.step}` +
    (entry.assertion ? ` — ${entry.assertion}` : "") +
    (entry.error ? ` ERROR: ${entry.error}` : "")
  );

  if (entry.conversationIdRequested !== undefined &&
      entry.conversationIdReturned !== undefined &&
      entry.conversationIdRequested !== entry.conversationIdReturned) {
    console.error(
      `  🚨 INVARIANT VIOLATED: conversationId mismatch — requested=${entry.conversationIdRequested} returned=${entry.conversationIdReturned}`
    );
  }

  if (entry.conversationIdActive !== undefined &&
      entry.conversationIdRendered !== undefined &&
      entry.conversationIdActive !== entry.conversationIdRendered) {
    console.error(
      `  🚨 INVARIANT VIOLATED: rendered conversation differs from active — active=${entry.conversationIdActive} rendered=${entry.conversationIdRendered}`
    );
  }
}

export function getEvidenceLog(): EvidenceEntry[] {
  return [...log];
}

export function resetEvidenceLog(): void {
  log.length = 0;
}

export function printEvidenceSummary(): void {
  const counts = { PASS: 0, FAIL: 0, WARNING: 0, INFO: 0 };
  for (const e of log) counts[e.status]++;

  console.log("\n══════════════════════════════════════════════");
  console.log("EVIDENCE SUMMARY");
  console.log(`  ✅ PASS:    ${counts.PASS}`);
  console.log(`  ❌ FAIL:    ${counts.FAIL}`);
  console.log(`  ⚠️  WARNING: ${counts.WARNING}`);
  console.log(`  ℹ️  INFO:    ${counts.INFO}`);

  const failures = log.filter((e) => e.status === "FAIL");
  if (failures.length) {
    console.log("\nFAILURES:");
    for (const f of failures) {
      console.log(`  [${f.traceId.slice(0, 8)}] ${f.scenario} / ${f.step}`);
      if (f.assertion) console.log(`    assertion: ${f.assertion}`);
      if (f.expected !== undefined) console.log(`    expected:  ${JSON.stringify(f.expected)}`);
      if (f.actual   !== undefined) console.log(`    actual:    ${JSON.stringify(f.actual)}`);
      if (f.error)                  console.log(`    error:     ${f.error}`);
    }
  }
  console.log("══════════════════════════════════════════════\n");
}
