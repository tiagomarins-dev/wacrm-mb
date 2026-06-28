// ============================================================
// Setup global do Playwright: loga via UI uma vez e persiste o
// storageState (cookies sb-* do @supabase/ssr). Todas as specs
// herdam a sessão (use.storageState). Usuário SEED dedicado, num
// projeto Supabase de TESTE (nunca produção).
// ============================================================
import { test as setup, expect } from "@playwright/test";

const AUTH_FILE = "e2e/.auth/user.json";

setup("autenticar", async ({ page }) => {
  await page.goto("/login");
  // Seletores robustos a i18n (input type=email/password do form de login).
  await page.locator('input[type="email"]').fill(process.env.E2E_TEST_EMAIL!);
  await page
    .locator('input[type="password"]')
    .fill(process.env.E2E_TEST_PASSWORD!);
  await page.getByRole("button", { name: /entrar|sign in|log in/i }).click();
  // Espera o redirect protegido — confirma sessão válida.
  await page.waitForURL(/\/dashboard/);
  await expect(page).toHaveURL(/\/dashboard/);
  await page.context().storageState({ path: AUTH_FILE });
});
