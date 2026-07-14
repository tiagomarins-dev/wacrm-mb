// Decide se o auto-redeem do convite deve disparar: convite válido (peek.ok) +
// sessão ativa + ainda não rodou (guard). Pura p/ ser testável sem DOM. O gate
// peek.ok exclui token 'used' → reabrir convite resgatado NÃO re-dispara.
export function shouldAutoRedeem(
  peek: { ok: boolean } | null,
  authedUserId: string | null | undefined,
  alreadyRan: boolean,
): boolean {
  return peek?.ok === true && !!authedUserId && !alreadyRan;
}
