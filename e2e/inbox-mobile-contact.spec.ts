// ============================================================
// E2E — mobile: nome do contato visível + acesso aos detalhes.
// Guarda contra a regressão do "nome colapsado no header" e garante
// que o painel de detalhes (ContactSidebar) é alcançável no mobile.
// Requer projeto Supabase de TESTE seedado com ≥1 conversa + envs E2E_*
// (e2e/global.setup.ts). Não roda em CI — suíte chromium local/staging.
// Os seletores da lista podem precisar de ajuste ao DOM real.
// ============================================================
import { test, expect } from "@playwright/test";

// Viewport de celular — reproduz o cenário do bug (header apertado).
test.use({ viewport: { width: 375, height: 812 } });

test("mobile: nome do contato aparece e detalhes abrem", async ({ page }) => {
  await page.goto("/inbox");

  // Abre a 1ª conversa da lista (o thread ocupa a tela toda no mobile).
  await page.locator("h3, [role='button'], button").first().waitFor();
  const firstConv = page
    .getByRole("button")
    .filter({ hasNotText: /whatsapp|settings/i })
    .first();
  await firstConv.click();

  // (1) nome do contato visível e não-vazio no header.
  const name = page.locator("header h2, h2").first();
  await expect(name).toBeVisible();
  await expect(name).not.toHaveText("");

  // (2) tocar no nome abre o painel de detalhes (tela cheia mobile).
  await name.click();
  await expect(page.getByText(/detalhes do contato/i)).toBeVisible();

  // (3) Esc fecha o overlay (a11y).
  await page.keyboard.press("Escape");
  await expect(page.getByText(/detalhes do contato/i)).toHaveCount(0);
});
