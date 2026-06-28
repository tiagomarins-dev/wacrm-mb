// Fumaça: a sessão do storageState abre o dashboard sem cair no /login.
import { test, expect } from "@playwright/test";

test("dashboard abre autenticado", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard/);
});
