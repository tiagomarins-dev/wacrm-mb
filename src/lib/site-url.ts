import "server-only";

// Resolve a URL pública do app. SITE_URL (runtime, NÃO-inlined) tem prioridade —
// operador seta no .env.local e só RECRIA o container (--no-build), sem rebuild.
// NEXT_PUBLIC_SITE_URL (inlined no build) é fallback retrocompat.
// SERVER-ONLY: SITE_URL não é exposto ao client (o import "server-only" barra
// uso em Client Component, onde a env sempre seria undefined).
export function getSiteUrl(): string | undefined {
  const raw =
    process.env.SITE_URL?.trim() || process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!raw) return undefined;

  // Tira barra(s) final e valida http/https — config malformada não vira link.
  const trimmed = raw.replace(/\/+$/, "");
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return trimmed;
}
