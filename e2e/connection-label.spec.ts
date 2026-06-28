// ============================================================
// E2E Fase A — label editável aparece no dropdown de conexão ativa.
// Requer projeto Supabase de TESTE com 2+ conexões seedadas (o switcher
// só aparece com 2+) e as envs E2E_* + storageState (e2e/global.setup.ts).
// Não roda em CI (sem Supabase de teste) — suíte chromium local/staging.
// ============================================================
import { test, expect } from "@playwright/test";

test("apelido salvo aparece no seletor de conexão", async ({ page }) => {
  // Edita o apelido da conexão em Settings ▸ WhatsApp.
  await page.goto("/settings");
  await page.getByRole("button", { name: /whatsapp/i }).click();

  const apelido = `E2E ${Date.now()}`;
  // Campo "Apelido da conexão" (primeiro input do form de credenciais).
  const labelInput = page.getByPlaceholder(/principal, vendas, suporte|primary, sales, support/i);
  await labelInput.fill(apelido);
  await page.getByRole("button", { name: /salvar|save/i }).first().click();

  // O dropdown de conexão ativa (header) passa a exibir o apelido.
  await expect(
    page.getByRole("button", { name: /trocar conexão|switch connection/i }),
  ).toContainText(apelido);
});
