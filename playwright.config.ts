// ============================================================
// Config Playwright. NÃO roda em CI (CI só tem Supabase dummy).
// webServer sobe o app BUILDADO (determinístico, sem HMR). Projeto
// 'setup' loga uma vez e salva storageState; 'chromium' é a suíte
// default (exclui @real-evolution); 'evolution' exige o container
// (fases C/D/E). workers:1 + serial → sem corrida no Supabase de teste.
// ============================================================
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    storageState: "e2e/.auth/user.json",
  },
  projects: [
    { name: "setup", testMatch: /global\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
      grepInvert: /@real-evolution/,
    },
    {
      name: "evolution",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
      grep: /@real-evolution/,
    },
  ],
  webServer: {
    // App buildado por padrão; localmente dá p/ apontar p/ dev via env.
    command: process.env.E2E_WEBSERVER_CMD ?? "npm run build && npm run start",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
