// ============================================================
// E2E — deep-link `/inbox?c=<id>` para conversa FORA do conjunto que a lista
// carrega (finalizada, ou além do teto de INBOX_LIST_LIMIT). Guarda contra a
// regressão do bug em que a thread não abria porque o deep-link procurava a
// conversa na lista truncada, e contra a conversa sumir no resync (o refetch
// dispara a cada visibilitychange). Requer projeto Supabase de TESTE seedado
// com ≥1 conversa + envs E2E_* (e2e/global.setup.ts). Não roda em CI.
//
// ⚠️ NUNCA EXECUTADO: escrito junto com a correção, mas a conta não tem projeto
// Supabase de teste nem envs E2E_* — rodar contra produção marcaria conversa de
// cliente como lida. Os seletores são inferidos do DOM e precisam de ajuste na
// primeira execução; não trate este arquivo como suíte verde.
// ============================================================
import { test, expect } from "@playwright/test";

test.describe("deep-link do inbox", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("abre a thread por id e sobrevive à troca de aba", async ({ page }) => {
    await page.goto("/inbox");

    // Abre a 1ª conversa da lista só para capturar um id real da URL.
    await page
      .getByRole("button")
      .filter({ hasNotText: /whatsapp|settings/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/inbox\?c=/);
    const convId = new URL(page.url()).searchParams.get("c");
    expect(convId).toBeTruthy();

    // Entra pelo deep-link em navegação limpa (cold mount): é aqui que o bug
    // aparecia — a lista ainda não carregou e o `find` não achava nada.
    await page.goto(`/inbox?c=${convId}`);
    const composer = page.getByRole("textbox").last();
    await expect(composer).toBeVisible();

    // Resync: o visibilitychange bumpa o resyncToken e refaz a query. Sem o
    // mergeKeepingActive, a conversa sairia da lista e o realce sumiria.
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(composer).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`c=${convId}`));
  });

  test("id inexistente avisa e limpa o ?c= da URL", async ({ page }) => {
    // UUID válido no formato, mas sem linha correspondente (a RLS devolve null
    // tanto para inexistente quanto para conversa de outra conta).
    await page.goto("/inbox?c=00000000-0000-4000-8000-000000000000");
    await expect(page.getByText(/não encontrada|not found/i)).toBeVisible();
    await expect(page).toHaveURL(/\/inbox$/);
  });
});
