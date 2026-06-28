#!/usr/bin/env bash
#
# install.sh — instalador wacrm via Docker.
# Coleta as variáveis de ambiente, gera segredos, escreve o .env.local,
# aplica as migrations no Supabase, cria o usuário admin, builda a
# imagem e sobe o container (app + Cloudflare Tunnel opcional).
#
# Uso:
#   ./install.sh            # fluxo completo (env + migrations + admin + up)
#   ./install.sh --rebuild  # reaproveita .env.local existente e só rebuilda
#
set -euo pipefail

# ---- cores pra deixar o output legível ----
BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RESET=$'\033[0m'

ENV_FILE=".env.local"
APP_PORT="${APP_PORT:-10300}"   # porta do host (override: APP_PORT=8080 ./install.sh)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

info()  { printf '%s\n' "${CYAN}$*${RESET}"; }
ok()    { printf '%s\n' "${GREEN}✓ $*${RESET}"; }
warn()  { printf '%s\n' "${YELLOW}! $*${RESET}"; }
err()   { printf '%s\n' "${RED}✗ $*${RESET}" >&2; }

# Gera segredo aleatório — usa openssl; cai pra node se não houver.
gen_secret() {
  local bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  elif command -v node >/dev/null 2>&1; then
    node -e "console.log(require('crypto').randomBytes($bytes).toString('hex'))"
  else
    err "Preciso de 'openssl' ou 'node' para gerar segredos."; exit 1
  fi
}

# Lê valor obrigatório — repete enquanto vier vazio. $3=1 esconde input.
ask_required() {
  local var="$1" prompt="$2" hidden="${3:-0}" val=""
  while [ -z "$val" ]; do
    if [ "$hidden" = "1" ]; then
      read -r -s -p "$(printf '%s' "${BOLD}${prompt}${RESET}: ")" val; echo
    else
      read -r -p "$(printf '%s' "${BOLD}${prompt}${RESET}: ")" val
    fi
    [ -z "$val" ] && warn "Obrigatório."
  done
  printf -v "$var" '%s' "$val"
}

# Lê valor opcional — pode ficar vazio.
ask_optional() {
  local var="$1" prompt="$2" val=""
  read -r -p "$(printf '%s' "${prompt} ${YELLOW}(opcional, Enter pula)${RESET}: ")" val
  printf -v "$var" '%s' "$val"
}

# ---- detecta docker e docker compose ----
detect_docker() {
  command -v docker >/dev/null 2>&1 || { err "Docker não encontrado. Instala o Docker Desktop."; exit 1; }
  docker info >/dev/null 2>&1 || { err "Docker não está rodando. Abre o Docker Desktop e tenta de novo."; exit 1; }
  if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
  else
    err "docker compose não disponível."; exit 1
  fi
  ok "Docker pronto ($COMPOSE)"
}

# ---- coleta as variáveis e escreve o .env.local ----
collect_and_write_env() {
  if [ -f "$ENV_FILE" ]; then
    warn "$ENV_FILE já existe."
    read -r -p "Sobrescrever? [s/N]: " ans
    case "${ans:-N}" in
      s|S|y|Y) info "Recriando $ENV_FILE…" ;;
      *) info "Mantendo $ENV_FILE atual."; return 0 ;;
    esac
  fi

  echo
  info "== Supabase (Project Settings → API) =="
  ask_required SUPABASE_URL        "NEXT_PUBLIC_SUPABASE_URL (https://xxx.supabase.co)"
  ask_required SUPABASE_ANON_KEY   "NEXT_PUBLIC_SUPABASE_ANON_KEY"
  ask_required SUPABASE_SERVICE    "SUPABASE_SERVICE_ROLE_KEY (secreta)" 1

  echo
  info "== Meta / WhatsApp (Meta for Developers → App Settings → Basic) =="
  ask_required META_APP_SECRET     "META_APP_SECRET" 1
  ask_optional META_APP_ID         "META_APP_ID (só p/ templates com header de imagem)"

  echo
  info "== OpenRouter (resumo IA p/ compartilhar conversa — opcional) =="
  ask_optional OPENROUTER_API_KEY  "OPENROUTER_API_KEY (admin pode configurar depois em Settings)"

  echo
  info "== Cloudflare Tunnel (domínio público, sem abrir portas) =="
  warn "Antes: no dashboard Zero Trust → Networks → Tunnels, crie um tunnel,"
  warn "aponte o Public Hostname para  http://app:3000  e copie o token."
  CF_TUNNEL_TOKEN=""; DOMAIN=""; SITE_URL=""
  read -r -p "$(printf '%s' "${BOLD}Configurar Cloudflare Tunnel agora?${RESET} [s/N]: ")" use_tunnel
  case "${use_tunnel:-N}" in
    s|S|y|Y)
      ask_required DOMAIN           "Domínio (ex: crm.seudominio.com, sem https://)"
      ask_required CF_TUNNEL_TOKEN  "CF_TUNNEL_TOKEN (token do tunnel)" 1
      SITE_URL="https://${DOMAIN}"
      ok "Tunnel ligado → $SITE_URL"
      ;;
    *)
      info "Sem tunnel. Defina a URL pública (necessária p/ links rastreáveis e convites)."
      ask_optional SITE_URL         "NEXT_PUBLIC_SITE_URL (ex: https://crm.seudominio.com)"
      if [ -z "${SITE_URL:-}" ]; then
        warn "NEXT_PUBLIC_SITE_URL vazio — links rastreáveis (Flows → nó de link, links de venda do Agente IA) e links de convite NÃO funcionam até você defini-lo no .env.local e rebuildar."
      fi
      ;;
  esac

  # Segredos gerados automaticamente — sem digitar.
  info "Gerando ENCRYPTION_KEY (AES-256-GCM, 32 bytes)…"
  ENCRYPTION_KEY="$(gen_secret 32)"
  info "Gerando AUTOMATION_CRON_SECRET…"
  CRON_SECRET="$(gen_secret 32)"
  ok "Segredos gerados."

  # Escreve o arquivo. Linhas opcionais vazias entram comentadas.
  {
    echo "# Gerado por install.sh — $ENV_FILE"
    echo
    echo "# --- Supabase (obrigatório) ---"
    echo "NEXT_PUBLIC_SUPABASE_URL=$SUPABASE_URL"
    echo "NEXT_PUBLIC_SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY"
    echo "SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE"
    echo
    echo "# --- Segredos (gerados automaticamente) ---"
    echo "ENCRYPTION_KEY=$ENCRYPTION_KEY"
    echo "AUTOMATION_CRON_SECRET=$CRON_SECRET"
    echo
    echo "# --- Meta / WhatsApp ---"
    echo "META_APP_SECRET=$META_APP_SECRET"
    if [ -n "${META_APP_ID:-}" ]; then echo "META_APP_ID=$META_APP_ID"; else echo "# META_APP_ID="; fi
    echo
    echo "# --- OpenRouter (resumo IA, opcional/fallback) ---"
    if [ -n "${OPENROUTER_API_KEY:-}" ]; then echo "OPENROUTER_API_KEY=$OPENROUTER_API_KEY"; else echo "# OPENROUTER_API_KEY="; fi
    echo
    echo "# --- Deploy ---"
    if [ -n "${SITE_URL:-}" ]; then echo "NEXT_PUBLIC_SITE_URL=$SITE_URL"; else echo "# NEXT_PUBLIC_SITE_URL="; fi
    echo
    echo "# --- Cloudflare Tunnel ---"
    if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then echo "CF_TUNNEL_TOKEN=$CF_TUNNEL_TOKEN"; else echo "# CF_TUNNEL_TOKEN="; fi
    if [ -n "${DOMAIN:-}" ]; then echo "TUNNEL_DOMAIN=$DOMAIN"; else echo "# TUNNEL_DOMAIN="; fi
  } > "$ENV_FILE"

  chmod 600 "$ENV_FILE"
  ok "$ENV_FILE escrito (permissão 600)."
}

# Lê o valor de uma chave do .env.local (ignora linhas comentadas).
read_env() {
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true
}

# Garante que AUTOMATION_CRON_SECRET exista no .env.local. .env.local antigos
# (anteriores ao sidecar de cron) não têm o segredo — sem ele os crons
# (agente IA, broadcasts agendados, automations, flows, transcrição, relatórios)
# falham na autenticação. Gera e anexa se faltar. Usado no fluxo --rebuild.
ensure_cron_secret() {
  if [ -n "$(read_env AUTOMATION_CRON_SECRET)" ]; then return 0; fi
  warn "AUTOMATION_CRON_SECRET ausente no $ENV_FILE — gerando (necessário p/ agente IA, agendamentos e relatórios)."
  printf '\n# --- Segredo do cron (gerado por --rebuild) ---\nAUTOMATION_CRON_SECRET=%s\n' "$(gen_secret 32)" >> "$ENV_FILE"
  ok "AUTOMATION_CRON_SECRET adicionado."
}

# Escapa string para uso seguro dentro de JSON (barra e aspas).
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# ---- aplica as migrations no Supabase ----
# Roda TODOS os .sql de supabase/migrations em ordem numérica (001, 002, …)
# via psql dentro de um container postgres:16-alpine (sem exigir psql
# instalado no host). Pega novas migrations automaticamente — o glob varre
# a pasta, não há lista fixa. Idempotente: os scripts usam IF NOT EXISTS /
# DROP IF EXISTS, seguro re-rodar numa base já migrada.
apply_migrations() {
  local dir="supabase/migrations"
  [ -d "$dir" ] || { warn "Pasta $dir não encontrada — pulando migrations."; return 0; }

  echo
  info "== Migrations do banco (Supabase) =="
  read -r -p "$(printf '%s' "${BOLD}Aplicar as migrations no Supabase agora?${RESET} [s/N]: ")" ans
  case "${ans:-N}" in s|S|y|Y) ;; *) info "Pulando migrations."; return 0 ;; esac

  warn "Pegue a connection string em: Supabase → Settings → Database → Connection string → URI"
  warn "Formato: postgresql://postgres:SENHA@db.SEU-REF.supabase.co:5432/postgres"
  local conn=""
  ask_required conn "Connection string do Postgres" 1

  # Supabase exige SSL — garante sslmode=require na URI.
  case "$conn" in
    *sslmode=*) ;;                       # já tem, não mexe
    *\?*) conn="${conn}&sslmode=require" ;;
    *)    conn="${conn}?sslmode=require" ;;
  esac

  info "Garantindo imagem postgres:16-alpine…"
  docker pull -q postgres:16-alpine >/dev/null 2>&1 || true

  # A connection string vai via env var (-e PGURI, sem valor inline) para
  # a senha NÃO aparecer no process table do host (/proc/<pid>/cmdline).
  # O psql lê a URI de $PGURI dentro do container via sh -c.
  # Testa conexão antes de começar.
  if ! PGURI="$conn" docker run --rm -i -e PGURI postgres:16-alpine \
       sh -c 'psql "$PGURI" -tAc "SELECT 1"' >/dev/null 2>&1; then
    err "Não consegui conectar no banco. Confira a connection string (senha/host)."
    return 1
  fi
  ok "Conexão OK."

  local f name out count=0
  for f in "$dir"/*.sql; do            # glob ordena 001..023 lexicograficamente
    name="$(basename "$f")"
    if out="$(PGURI="$conn" docker run --rm -i -e PGURI postgres:16-alpine \
              sh -c 'psql "$PGURI" -v ON_ERROR_STOP=1 -q' < "$f" 2>&1)"; then
      ok "  $name"
      count=$((count + 1))
    else
      err "  $name FALHOU — abortando:"
      printf '%s\n' "$out"
      return 1
    fi
  done
  ok "$count migrations aplicadas."
}

# ---- cria o primeiro usuário admin ----
# Usa a Auth Admin API oficial do Supabase (com a service-role key) —
# cria auth.users + dispara o trigger handle_new_user que monta
# account + profile (role owner). email_confirm=true pula e-mail.
create_admin_user() {
  echo
  info "== Usuário admin =="
  read -r -p "$(printf '%s' "${BOLD}Criar usuário admin agora?${RESET} [s/N]: ")" ans
  case "${ans:-N}" in s|S|y|Y) ;; *) info "Pulando criação de usuário."; return 0 ;; esac

  local url svc email pw name
  url="$(read_env NEXT_PUBLIC_SUPABASE_URL)"
  svc="$(read_env SUPABASE_SERVICE_ROLE_KEY)"
  if [ -z "$url" ] || [ -z "$svc" ]; then
    err "URL/Service key ausentes no $ENV_FILE — não dá pra criar usuário."
    return 1
  fi

  ask_required email "E-mail do admin"
  ask_required pw    "Senha (mín. 6 caracteres)" 1
  ask_optional name  "Nome completo"

  local payload resp cfg
  payload="{\"email\":\"$(json_escape "$email")\",\"password\":\"$(json_escape "$pw")\",\"email_confirm\":true,\"user_metadata\":{\"full_name\":\"$(json_escape "${name:-}")\"}}"

  # Headers sensíveis (service-role key) num arquivo 0600 lido via curl -K,
  # e o body (com a senha) via stdin (--data-binary @-). Assim nem a key
  # nem a senha aparecem no process table (argv) do host.
  cfg="$(mktemp)"; chmod 600 "$cfg"
  {
    printf 'header = "apikey: %s"\n' "$svc"
    printf 'header = "Authorization: Bearer %s"\n' "$svc"
    printf 'header = "Content-Type: application/json"\n'
  } > "$cfg"
  resp="$(printf '%s' "$payload" | curl -sS -X POST "${url%/}/auth/v1/admin/users" \
    -K "$cfg" --data-binary @- 2>&1)"
  rm -f "$cfg"

  if printf '%s' "$resp" | grep -q '"id"'; then
    ok "Usuário criado: $email (confirmado, role owner)."
  elif printf '%s' "$resp" | grep -qiE 'already|registered|exists'; then
    warn "Usuário $email já existe — seguindo."
  else
    err "Falha ao criar usuário:"
    printf '%s\n' "$resp"
    return 1
  fi
}

# ---- sobe o stack ----
bring_up() {
  echo
  # Ativa o serviço cloudflared só se houver token no .env.local.
  local profiles="" tunnel_token domain
  tunnel_token="$(read_env CF_TUNNEL_TOKEN)"
  domain="$(read_env TUNNEL_DOMAIN)"
  if [ -n "$tunnel_token" ]; then
    profiles="--profile tunnel"
    info "Cloudflare Tunnel habilitado."
  fi

  info "Buildando imagem e subindo container… (porta host: $APP_PORT)"
  # --env-file: interpola build args NEXT_PUBLIC_* + CF_TUNNEL_TOKEN do .env.local.
  # APP_PORT exportado para o compose mapear a porta do host.
  APP_PORT="$APP_PORT" $COMPOSE --env-file "$ENV_FILE" $profiles up -d --build
  echo
  ok "wacrm no ar (local) → ${BOLD}http://localhost:$APP_PORT${RESET}"
  if [ -n "$domain" ]; then
    ok "Domínio público → ${BOLD}https://$domain${RESET}"
    warn "DNS/rota gerenciados no dashboard Cloudflare; pode levar ~1 min."
  fi
  echo
  info "Logs:  $COMPOSE --env-file $ENV_FILE $profiles logs -f"
  info "Parar: $COMPOSE --env-file $ENV_FILE $profiles down"
}

# ---- guia de próximos passos (config dentro do app) ----
# O .env.local + migrations sobem o sistema; mas várias features (WhatsApp,
# agente IA, transcrição, relatórios, dados do aluno) são ligadas DENTRO do
# app pelo admin. Imprime o passo a passo pra deixar tudo 100% funcional.
print_next_steps() {
  local base="http://localhost:$APP_PORT"
  # No --rebuild SITE_URL não foi coletado nesta execução — lê do .env.local.
  SITE_URL="${SITE_URL:-$(read_env NEXT_PUBLIC_SITE_URL)}"
  echo
  echo "${BOLD}== Próximos passos (configurar dentro do app) ==${RESET}"
  echo
  info "1) Entre e faça login"
  echo "   $base  →  use o e-mail/senha do admin que você criou."
  echo
  info "2) Conecte um número de WhatsApp  (Settings → Conexões)"
  echo "   $base/settings?tab=whatsapp"
  echo "   - Cole Phone Number ID, WABA ID e o token permanente da Meta."
  echo "   - Configure o webhook no painel da Meta apontando para:"
  echo "       ${SITE_URL:-<sua-URL-pública>}/api/whatsapp/webhook"
  echo "     Verify token: o mesmo que você definir na tela de conexão."
  warn "   Webhook exige HTTPS público — use o Cloudflare Tunnel ou outra URL HTTPS."
  echo
  info "3) Ative a IA  (Settings → Integrações)  — opcional, mas habilita várias features"
  echo "   $base/settings?tab=integrations"
  echo "   - Cole sua OpenRouter API key → liga: resumo IA ao compartilhar conversa,"
  echo "     agente de IA (respostas automáticas) e transcrição de áudios."
  echo "   - (MB) API \"Info Aluno\" (Millaborges): cole a key p/ o painel Dados do Aluno."
  echo
  info "4) Configure o agente de IA  (Settings → Agente IA)  — se for usar respostas automáticas"
  echo "   $base/settings?tab=ai-agent"
  echo "   - Defina perfil/instruções, allowlist de números e o debounce."
  echo
  info "5) Horário de atendimento + relatórios  (Settings → Horário)"
  echo "   $base/settings?tab=business-hours"
  echo "   - Define o expediente; os relatórios (FRT/ART) usam isso para clipar tempos."
  echo
  info "6) Templates e respostas rápidas"
  echo "   $base/settings?tab=templates   |   $base/settings?tab=quick-replies"
  echo
  ok "O scheduler de cron (agente IA, agendamentos, automações, transcrição, relatórios)"
  echo "   já está rodando no container ${BOLD}wacrm-cron${RESET} — nada a fazer."
}

# ============================================================
# Execução
# ============================================================
echo "${BOLD}== Instalador wacrm (Docker) ==${RESET}"
detect_docker

if [ "${1:-}" = "--rebuild" ]; then
  [ -f "$ENV_FILE" ] || { err "$ENV_FILE não existe. Roda sem --rebuild primeiro."; exit 1; }
  ok "Reusando $ENV_FILE existente."
  ensure_cron_secret
else
  collect_and_write_env
  # Banco antes do usuário: o trigger handle_new_user (migration 001+017)
  # precisa existir para o admin criar account + profile.
  apply_migrations
  create_admin_user
fi

bring_up
print_next_steps
