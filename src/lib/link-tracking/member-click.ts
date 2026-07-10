import { createClient } from '@/lib/supabase/server'

// Detecta se quem clicou o /r/ é membro logado da conta do token → p/ IGNORAR o clique
// interno (atendente clicando o próprio link não pode virar clique falso). Fail-open:
// qualquer erro → false (conta o clique). Sem cookie de sessão Supabase → false SEM
// instanciar o client (o contato no WhatsApp não tem cookie → a maioria dos cliques sai barato).
export async function isLoggedMemberClick(req: Request, accountId: string): Promise<boolean> {
  const hasSession = req.headers.get('cookie')?.includes('sb-') ?? false
  if (!hasSession) return false
  try {
    const sb = await createClient()
    const {
      data: { user },
    } = await sb.auth.getUser()
    if (!user) return false
    const { data: prof } = await sb
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    return prof?.account_id === accountId
  } catch {
    return false // fail-open: erro na sessão nunca quebra o rastreio
  }
}
