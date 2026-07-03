// ============================================================
// E2E — desktop: "destacar" a conversa num modal quase full-screen.
// Guarda contra regressão do botão Expandir e confirma que ele NÃO
// aparece no mobile. Requer projeto Supabase de TESTE seedado com ≥1
// conversa + envs E2E_* (e2e/global.setup.ts). Não roda em CI.
// Os seletores da lista podem precisar de ajuste ao DOM real.
// ============================================================
import { test, expect } from "@playwright/test";

// Playwright não aceita 2 viewports num único test.use → dois describe.
test.describe("expand desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("maximizar a conversa abre overlay e Esc fecha", async ({ page }) => {
    await page.goto("/inbox");
    // Abre a 1ª conversa da lista.
    await page
      .getByRole("button")
      .filter({ hasNotText: /whatsapp|settings/i })
      .first()
      .click();
    // Botão Expandir conversa no header do thread.
    await page.getByRole("button", { name: /expandir conversa/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // Esc fecha o overlay.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("maximizar a info do aluno abre overlay e Esc fecha", async ({ page }) => {
    await page.goto("/inbox");
    await page
      .getByRole("button")
      .filter({ hasNotText: /whatsapp|settings/i })
      .first()
      .click();
    // Botão Expandir painel no topo do ContactSidebar (bug 3 corrigido).
    await page.getByRole("button", { name: /expandir painel/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("expand ausente no mobile", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("sem botão de expandir no mobile", async ({ page }) => {
    await page.goto("/inbox");
    await page
      .getByRole("button")
      .filter({ hasNotText: /whatsapp|settings/i })
      .first()
      .click();
    await expect(
      page.getByRole("button", { name: /expandir conversa/i }),
    ).toHaveCount(0);
  });
});
