/**
 * Script one-time: captura o storage state da sessão autenticada em http://localhost:8080
 * e salva em tests/e2e/.auth/session.json para ser usado pelos testes REAL.
 *
 * Execução: npx playwright test tests/e2e/save-auth-state.ts --reporter=list
 *
 * O arquivo gerado NÃO deve ser commitado (contém tokens reais).
 * Adicionar a .gitignore: tests/e2e/.auth/
 */

import { test } from "@playwright/test";
import path from "path";
import fs from "fs";

test("save-auth-state — captura sessão real e salva storage state", async ({ browser }) => {
  const authDir = path.join(process.cwd(), "tests/e2e/.auth");
  fs.mkdirSync(authDir, { recursive: true });

  // Abre o app real (precisa estar rodando em http://localhost:8080)
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("http://localhost:8080");
  await page.waitForTimeout(3000); // Aguarda carregamento inicial

  // Salva o storage state completo (cookies + localStorage)
  await context.storageState({ path: path.join(authDir, "session.json") });
  console.log("[save-auth-state] Storage state salvo em tests/e2e/.auth/session.json");

  await context.close();
});
