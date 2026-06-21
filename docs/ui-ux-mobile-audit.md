# Auditoria UI/UX — Mobile-first (foco Inbox)

**Data:** 2026-06-20 · **Ambiente:** https://wacrm-hml.profmillaborges.com.br
**Método:** Playwright @ viewport **375×812** (iPhone-class), login real, navegação por
Inbox, Dashboard, Contacts, Pipelines, Broadcasts. Screenshots em `.playwright-mcp/`.
**Base de critérios:** skills `ui-ux-pro-max` + `frontend-design` (WCAG, touch 44px, no-overflow).

---

## Resumo executivo

A plataforma é **dark-first, limpa e consistente** no desktop. No **mobile** há um
problema estrutural recorrente — **overflow horizontal a 375px** — que degrada
justamente a tela mais usada (Inbox): timestamp, badge de não-lido e status da
conversa **existem no DOM mas não aparecem** porque a linha vaza pra fora da
viewport. Somado a isso, o Inbox mostra **dois cabeçalhos empilhados** no mobile,
desperdiçando ~110px antes da 1ª mensagem.

Prioridades:

| # | Severidade | Problema | Telas |
|---|-----------|----------|-------|
| P0-1 | 🔴 Alta | Overflow horizontal esconde metadados da conversa | Inbox (lista) |
| P0-2 | 🔴 Alta | Botões de ação cortados na borda (overflow) | Contacts, headers |
| P1-1 | 🟠 Média | Cabeçalho duplicado no thread mobile | Inbox (thread) |
| P1-2 | 🟠 Média | Header (título + botão) não empilha no mobile | Broadcasts, Contacts, Pipelines |
| P1-3 | 🟠 Média | Kanban: scroll horizontal + drag-drop em touch | Pipelines |
| P2-1 | 🟡 Baixa | Roxo primário muito saturado / contraste do texto | global |
| P2-2 | 🟡 Baixa | Tabelas densas no mobile (Contacts) | Contacts |
| P2-3 | 🟡 Baixa | Touch targets < 44px (toggles, 3-pontos, ícones) | global |

---

## P0-1 — Overflow esconde metadados da conversa (Inbox) 🔴

**Sintoma:** na lista de conversas (mobile), some o **horário**, o **badge de
não-lidas** e a **bolinha de status**; o texto de preview vaza pela borda direita
sem reticências. (`mb-inbox-mobile-list.png`)

**Evidência:** o accessibility tree tem tudo —
`"T Tiago Marins 35 minutes oi 1 open"` — mas o render visual corta. Logo, não é
falta de dado: é **largura não-limitada**.

**Causa provável:** `src/components/inbox/conversation-list.tsx:201` envolve a
lista num `ScrollArea`. O `ConversationItem` (linha 252+) já usa `min-w-0 flex-1`
+ `truncate` corretamente, mas o **viewport do ScrollArea** (base-ui/radix) aplica
`min-width: max-content` ao filho — isso **anula o `truncate`** (truncate precisa
de largura limitada; com `max-content` o conteúdo dita a largura → vaza).

**Correção:** garantir largura limitada dentro do ScrollArea.

1. Em `src/components/ui/scroll-area.tsx`, forçar o viewport interno a `w-full`
   e o filho a não expandir:
   ```tsx
   // no Viewport do ScrollArea
   className="... [&>div]:!w-full [&>div]:!min-w-0"
   ```
2. E/ou no `conversation-list.tsx:211`, trocar
   `<div className="flex flex-col">` por
   `<div className="flex w-full min-w-0 flex-col">`.
3. Validar: a 375px, cada linha deve mostrar **nome … horário** na 1ª linha e
   **preview truncado … badge + status** na 2ª, sem scroll horizontal.

**Critério de aceite:** `document.documentElement.scrollWidth === clientWidth` no
Inbox a 375px; horário + badge + status visíveis.

---

## P0-2 — Botões de ação cortados na borda 🔴

**Sintoma:** em **Contacts**, o botão **"Add Contact"** fica cortado na borda
direita (`mb-contacts-mobile.png`). A barra de ações (`Custom fields` · `Import` ·
`Add Contact`) não cabe em 375px e estoura em vez de quebrar/encolher.

**Causa:** linha de ações usa `flex` em linha única sem `flex-wrap` nem
versão mobile; rótulos longos não encolhem.

**Correção (padrão para todas as barras de ação):**
- Empilhar/encolher no mobile: `flex flex-wrap gap-2` no container; em telas muito
  estreitas, esconder rótulo e manter ícone: `<span className="hidden sm:inline">Add Contact</span>`.
- Alternativa mobile-first: botão primário vira **FAB** (canto inferior direito,
  `fixed bottom-4 right-4`) e os secundários entram num menu "⋯".
- Garantir `min-h-[44px]` nos botões (touch).

Arquivos: `src/app/(dashboard)/contacts/page.tsx` (barra de ações) e o mesmo
padrão em headers de Broadcasts/Pipelines.

---

## P1-1 — Cabeçalho duplicado no thread (Inbox) 🟠

**Sintoma:** ao abrir uma conversa no mobile (`mb-inbox-mobile-thread.png`)
aparecem **dois headers**: o banner global do app (☰ + "Inbox" + 🌙 + avatar) e o
header da conversa (← + Tiago Marins + status + atribuir). ~110px gastos antes da
1ª mensagem; numa tela de chat, vertical é precioso.

**Correção:** quando um thread está aberto **no mobile**, esconder o banner global
e deixar só o header da conversa (que já tem o ← para voltar).
- No shell (`src/app/(dashboard)/dashboard-shell.tsx`) ou no layout do Inbox,
  condicionar o banner: `className="... lg:flex hidden"` quando `?c=<id>` ativo,
  OU dar ao Inbox um header próprio full-bleed que substitui o global no mobile.
- Manter o ☰ acessível: mover para dentro do header da conversa (ou um gesto de
  voltar) já que o ← cobre a navegação de saída do thread.

**Ganho:** +~60px de área de mensagens; padrão consistente com WhatsApp/Telegram.

---

## P1-2 — Header (título + ação) não empilha no mobile 🟠

**Sintoma:** em Broadcasts (`mb-broadcasts-mobile.png`), o botão "New Broadcast"
disputa espaço com a descrição que quebra em 3 linhas ao lado dele. Mesmo padrão
em Contacts/Pipelines.

**Correção:** header responsivo —
```tsx
<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
  <div>…título + descrição…</div>
  <GatedButton className="w-full sm:w-auto">New Broadcast</GatedButton>
</div>
```
No mobile o botão vira full-width abaixo do título (alvo de toque grande, sem
competir com o texto).

---

## P1-3 — Kanban no mobile (Pipelines) 🟠

**Sintoma:** (`mb-pipelines-mobile.png`) o board rola horizontalmente (próxima
coluna espia na borda). Aceitável, mas **drag-drop com `@dnd-kit` em touch** é
frágil em telas estreitas (alvo pequeno, scroll vs drag competem).

**Correção:**
- Manter scroll horizontal das colunas, mas dar **scroll-snap** por coluna
  (`snap-x snap-mandatory` + `snap-center`) e largura de coluna `~85vw` para
  uma coluna por vez no mobile.
- Mover deal por **menu "mover para…"** (toque) como alternativa ao drag em
  telas `< sm` — drag-drop touch só como complemento.
- Garantir o `TouchSensor` do dnd-kit com `activationConstraint: { delay: 150,
  tolerance: 8 }` para não conflitar com o scroll.

Arquivos: `src/components/pipelines/pipeline-board.tsx`, `deal-card.tsx`.

---

## P2 — Refinos (Médio/Baixo)

**P2-1 Cor primária:** o roxo das bolhas/CTA é muito saturado (≈`#a855f7`),
cansativo em blocos grandes (bolhas de mensagem). Verificar contraste do texto
branco sobre o roxo (mirar ≥4.5:1) e considerar dessaturar levemente para os
blocos grandes, mantendo o vívido só em CTAs pequenos. O design-system sugere
indigo `#6366F1` + CTA emerald `#10B981` como alternativa equilibrada.

**P2-2 Tabela de contatos no mobile:** `mb-contacts-mobile.png` mostra tabela
Name|Phone densa. Considerar **cards** no mobile (`< sm`): nome em destaque,
telefone + tags abaixo, ⋯ à direita — mais legível e com alvos maiores que
células de tabela.

**P2-3 Touch targets:** o toggle dark, o ⋯ de contato e ícones do composer
parecem < 44px. Aplicar `min-h-[44px] min-w-[44px]` (ou `p-2.5`) em todos os
ícone-botões. (regra `touch-target-size`, severidade Alta na base UX.)

**Acessibilidade geral (verificar/garantir):**
- `focus-visible:ring-2` em todos os interativos (navegação por teclado).
- `aria-label` nos ícone-botões (☰, 🌙, enviar, anexar, ⋯).
- `prefers-reduced-motion` respeitado nas animações (ex.: barra indeterminada de
  broadcast, spinners).

---

## Análise por tela

| Tela | Mobile | Notas |
|------|--------|-------|
| **Dashboard** | ✅ Bom | Cards de métrica empilham bem; deltas com seta/cor. OK. |
| **Inbox (lista)** | 🔴 | Overflow esconde horário/badge/status (P0-1). |
| **Inbox (thread)** | 🟠 | Header duplicado (P1-1); bolhas e composer OK. |
| **Contacts** | 🔴 | "Add Contact" cortado (P0-2); tabela densa (P2-2). |
| **Pipelines** | 🟠 | Métricas OK; kanban touch frágil (P1-3). |
| **Broadcasts** | 🟢 | Tabela esconde colunas no mobile (bom); só o header (P1-2). |

---

## Alinhamento com o design-system recomendado

- **Estilo:** Flat Design (web app/SaaS, WCAG AAA, performance excelente) — já
  alinhado (sem sombras pesadas, ícones SVG Lucide).
- **Tipografia (dashboards):** par sugerido Fira Sans (corpo) + Fira Code
  (números/dados). Avaliar para os cards de métrica.
- **Transições:** 150–300ms (micro-interações) — manter; evitar `scale` no hover
  que causa layout shift; preferir cor/opacidade.
- **Contraste claro/escuro:** corpo ≥4.5:1; bordas visíveis nos dois modos.

---

## Roadmap priorizado

**Sprint 1 (P0 — quebra mobile):**
1. Corrigir overflow do ScrollArea no Inbox (P0-1) — 1 fix, alto impacto.
2. Barras de ação responsivas / botões que não cortam (P0-2).
3. Sweep global anti-overflow: `overflow-x-hidden` no container raiz do shell +
   auditar cada página a 375px (`scrollWidth === clientWidth`).

**Sprint 2 (P1 — experiência mobile):**
4. Esconder banner global no thread mobile (P1-1).
5. Headers que empilham (P1-2).
6. Kanban touch-friendly + scroll-snap (P1-3).

**Sprint 3 (P2 — polimento):**
7. Touch targets 44px + focus-visible + aria-labels.
8. Cards de contato no mobile.
9. Revisão de cor/contraste do primário.

---

## Checklist pré-entrega (por PR de UI)

- [ ] Sem scroll horizontal a 375/768/1024/1440 (`scrollWidth === clientWidth`)
- [ ] Todo ícone-botão ≥ 44×44px e com `aria-label`
- [ ] `focus-visible:ring` em interativos
- [ ] Texto ≥ 4.5:1 (claro e escuro)
- [ ] Hover sem layout shift (cor/opacidade, 150–300ms)
- [ ] `prefers-reduced-motion` respeitado
- [ ] Inbox: horário + badge + status visíveis na lista; thread sem header duplo

---

### Anexos (screenshots)
`.playwright-mcp/mb-dashboard-mobile.png` · `mb-inbox-mobile-list.png` ·
`mb-inbox-mobile-thread.png` · `mb-pipelines-mobile.png` ·
`mb-contacts-mobile.png` · `mb-broadcasts-mobile.png`
