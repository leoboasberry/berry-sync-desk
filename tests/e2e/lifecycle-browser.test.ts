/**
 * Testes E2E — BroadcastChannel e Web Locks reais no browser
 *
 * Usa o fixture tests/fixtures/lifecycle-page.html com APIs de browser reais.
 * Cada teste abre duas páginas no mesmo contexto para compartilhar BroadcastChannel.
 *
 * Cobertura:
 * - E2E-1: Duas páginas no mesmo contexto comunicam via BroadcastChannel real
 * - E2E-2: Aba emite CACHE_UPDATED; outra recebe
 * - E2E-3: LOGOUT em uma aba propaga para a outra
 * - E2E-4: Aba não processa o próprio evento (tabId guard)
 * - E2E-5: close() impede recepção de novos eventos
 * - E2E-6: Somente uma aba executa o callback com Web Locks (se disponível)
 * - E2E-7: Validação de fallback para caso Web Locks indisponível
 */

import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = "file://" + path.join(__dirname, "../fixtures/lifecycle-page.html");

// ── E2E-1: Duas páginas no mesmo contexto se comunicam ────────────────────────
test("E2E-1 — Duas páginas reais no mesmo contexto compartilham BroadcastChannel", async ({ browser }) => {
  const context = await browser.newContext();
  const page1 = await context.newPage();
  const page2 = await context.newPage();

  await page1.goto(FIXTURE);
  await page2.goto(FIXTURE);

  await page1.evaluate(() => window.__lc.init("berry-sync:e2e:test-user"));
  await page2.evaluate(() => window.__lc.init("berry-sync:e2e:test-user"));

  await page1.evaluate(() => window.__lc.send({ type: "CACHE_UPDATED", status: "open" }));

  // Wait for message to propagate
  await page2.waitForFunction(() => window.__lc.received.length > 0, { timeout: 3000 });

  const received = await page2.evaluate(() => window.__lc.received);
  expect(received[0].payload.type).toBe("CACHE_UPDATED");
  expect(received[0].payload.status).toBe("open");

  await context.close();
});

// ── E2E-2: Uma aba emite CACHE_UPDATED; a outra recebe ───────────────────────
test("E2E-2 — CACHE_UPDATED emitido por aba A é recebido por aba B", async ({ browser }) => {
  const context = await browser.newContext();
  const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);

  await Promise.all([p1.goto(FIXTURE), p2.goto(FIXTURE)]);
  await p1.evaluate(() => window.__lc.init("berry-sync:e2e:user-x"));
  await p2.evaluate(() => window.__lc.init("berry-sync:e2e:user-x"));

  await p1.evaluate(() => window.__lc.send({ type: "CACHE_UPDATED", status: "pending" }));
  await p2.waitForFunction(() => window.__lc.received.length > 0, { timeout: 3000 });

  const msg = await p2.evaluate(() => window.__lc.received[0]);
  expect(msg.payload.type).toBe("CACHE_UPDATED");
  expect(msg.payload.status).toBe("pending");

  await context.close();
});

// ── E2E-3: LOGOUT em uma aba propaga para a outra ─────────────────────────────
test("E2E-3 — LOGOUT emitido por aba A é recebido por aba B", async ({ browser }) => {
  const context = await browser.newContext();
  const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);

  await Promise.all([p1.goto(FIXTURE), p2.goto(FIXTURE)]);
  await p1.evaluate(() => window.__lc.init("berry-sync:e2e:user-logout"));
  await p2.evaluate(() => window.__lc.init("berry-sync:e2e:user-logout"));

  await p1.evaluate(() => window.__lc.send({ type: "LOGOUT" }));
  await p2.waitForFunction(() => window.__lc.received.length > 0, { timeout: 3000 });

  const msg = await p2.evaluate(() => window.__lc.received[0]);
  expect(msg.payload.type).toBe("LOGOUT");

  await context.close();
});

// ── E2E-4: Aba não processa o próprio evento (tabId guard) ───────────────────
test("E2E-4 — Aba não recebe o próprio broadcast (tabId guard)", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(FIXTURE);

  await page.evaluate(() => window.__lc.init("berry-sync:e2e:self-test"));
  await page.evaluate(() => window.__lc.send({ type: "CACHE_UPDATED", status: "open" }));

  // Give time for any self-delivery (should NOT happen)
  await page.waitForTimeout(300);

  const received = await page.evaluate(() => window.__lc.received);
  expect(received).toHaveLength(0); // own message not received

  await context.close();
});

// ── E2E-5: close() impede recepção de novos eventos ──────────────────────────
test("E2E-5 — close() impede recepção de eventos após fechamento", async ({ browser }) => {
  const context = await browser.newContext();
  const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);

  await Promise.all([p1.goto(FIXTURE), p2.goto(FIXTURE)]);
  await p1.evaluate(() => window.__lc.init("berry-sync:e2e:close-test"));
  await p2.evaluate(() => window.__lc.init("berry-sync:e2e:close-test"));

  // Close p2's lifecycle before the broadcast
  await p2.evaluate(() => window.__lc.close());

  await p1.evaluate(() => window.__lc.send({ type: "CACHE_UPDATED", status: "resolved" }));
  await p1.waitForTimeout(300);

  const received = await p2.evaluate(() => window.__lc.received);
  expect(received).toHaveLength(0); // closed — no events received

  await context.close();
});

// ── E2E-6: Web Locks real — somente uma aba executa o callback ───────────────
test("E2E-6 — Web Locks real: somente uma aba executa callback quando lock é ifAvailable", async ({ browser }) => {
  const context = await browser.newContext();
  const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);

  await Promise.all([p1.goto(FIXTURE), p2.goto(FIXTURE)]);

  // Check if Web Locks is available in this browser
  const hasLocks = await p1.evaluate(() => "locks" in navigator);

  if (!hasLocks) {
    test.skip();
    await context.close();
    return;
  }

  // p1 acquires lock and holds it
  const p1Acquired = p1.evaluate(() =>
    new Promise<boolean>((resolve) => {
      navigator.locks.request("berry-e2e-lock", async (lock) => {
        if (!lock) { resolve(false); return; }
        window.__lc.lockExecuted = true;
        // Hold the lock for 500ms
        await new Promise((r) => setTimeout(r, 500));
      });
      resolve(true);
    })
  );

  await p1.waitForFunction(() => window.__lc.lockExecuted === true, { timeout: 2000 });

  // p2 tries to acquire with ifAvailable=true — should be null (lock taken)
  const p2Result = await p2.evaluate(() =>
    navigator.locks.request("berry-e2e-lock", { ifAvailable: true }, async (lock) => {
      return lock !== null;
    })
  );

  expect(p2Result).toBe(false); // p2 was not granted the lock

  await p1Acquired;
  await context.close();
});

// ── E2E-7: SYNC_FINISHED entre abas ──────────────────────────────────────────
test("E2E-7 — SYNC_FINISHED emitido por aba A é recebido por aba B com fetchedAt", async ({ browser }) => {
  const context = await browser.newContext();
  const [p1, p2] = await Promise.all([context.newPage(), context.newPage()]);

  await Promise.all([p1.goto(FIXTURE), p2.goto(FIXTURE)]);
  await p1.evaluate(() => window.__lc.init("berry-sync:e2e:sync-finish"));
  await p2.evaluate(() => window.__lc.init("berry-sync:e2e:sync-finish"));

  const sentAt = Date.now();
  await p1.evaluate((ts) =>
    window.__lc.send({ type: "SYNC_FINISHED", status: "open", fetchedAt: ts }),
  sentAt);

  await p2.waitForFunction(() => window.__lc.received.length > 0, { timeout: 3000 });

  const msg = await p2.evaluate(() => window.__lc.received[0]);
  expect(msg.payload.type).toBe("SYNC_FINISHED");
  expect(msg.payload.status).toBe("open");
  expect(typeof msg.payload.fetchedAt).toBe("number");

  await context.close();
});
