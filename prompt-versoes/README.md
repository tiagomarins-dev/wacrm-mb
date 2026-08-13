# Versões de prompt da Ruth

Backup versionado dos prompts da agente de IA. Cada `.json` é um **export do playground**
(`/playground-ruth` → botão "Exportar JSON") e volta pra tela pelo botão "Importar JSON".

Nada aqui é lido em runtime — o que vale em produção é o registro em `ai_profiles` no
Supabase. Esta pasta existe pra ter histórico e poder voltar atrás.

## Perfis

| Perfil | Slug no banco | Uso |
|---|---|---|
| Ruth (Comercial) | `ruth` | quem chega sozinho (Instagram, indicação, dúvida avulsa) |
| Ruth Lançamento (Pesquisa) | `ruth-lancamento-pesquisa` | disparo ativo: template com botão → automação |

## Arquivos

| Arquivo | Perfil | O que é |
|---|---|---|
| `ruth-comercial-banco-2026-08-12.json` | Comercial | snapshot do que estava no banco (base v1) |
| `ruth-comercial-v2-2026-08-12.json` | Comercial | v2 |
| `ruth-comercial-v3-2026-08-12.json` | Comercial | v3 |
| `ruth-comercial-v4-2026-08-12.json` | Comercial | **v4 — versão corrente** |
| `ruth-campanha-banco-2026-08-12.json` | Lançamento | snapshot do que estava no banco (base v1) |
| `ruth-campanha-v2-2026-08-12.json` | Lançamento | v2 |
| `ruth-campanha-v3-2026-08-12.json` | Lançamento | v3 |
| `ruth-campanha-v4-2026-08-12.json` | Lançamento | **v4 — versão corrente** |
| `historico/ruth-comercial-2026-08-08.xml` | Comercial | prompt em XML, formato anterior ao playground |

## Conteúdo de cada JSON

`perfil` (id/nome/slug de origem) · `personaPrompt` · `openingPrompt` ·
`campaignContext` (só nos arquivos de campanha) · `courseDrafts` (rascunho de
posicionamento e condição por curso) · `rotulo` e `changelog` (a partir da v3).

## Changelog (v4)

- **v1** — prompts de produção capturados do banco em 12/08/2026.
- **v2** — âncora do ENEM na abertura, apresentação obrigatória em 3 tempos, produto-alvo
  vindo do contexto da campanha, disponibilidade só via `get_curso`, pagamento só cartão
  em 12x, cap de 1–2 balões, gate de venda em 4 passos no Comercial.
- **v3** — consolidação + scripts de venda por curso no posicionamento, destilados das
  vendas reais do João Paulo e da Maria Clara (diagnóstico → posicionamento → como
  funciona → objeções).
- **v4** — copy "correções humanizadas" (some o "100% humana" e a menção a IA) e roteiro
  de transferência em 3 partes: reconhecer a pergunta, acionar o analista, dar a
  expectativa de horário — transferência muda passou a ser proibida.

## Como aplicar em produção

O playground **não escreve no banco**. Pra promover uma versão: abrir o JSON, copiar
`personaPrompt` / `openingPrompt` e atualizar a linha correspondente em `ai_profiles`
(o campo de campanha agora vive na automação, não no perfil).
