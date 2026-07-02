#!/usr/bin/env bash
#
# rebuild.sh — rebuilda e sobe só o container `app` (build de produção do
# Next). Reusa o .env.local; NÃO toca migrations nem cria admin (isso é o
# install.sh). Mantém os sidecars (cron/evolution) rodando.
#
# Uso:
#   ./rebuild.sh          # rebuild do app (padrão)
#   ./rebuild.sh all      # rebuild de todos os serviços do compose
#
set -euo pipefail

BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ENV_FILE=".env.local"
APP_PORT="${APP_PORT:-10300}"
[ -f "$ENV_FILE" ] || { printf '%s\n' "${RED}✗ $ENV_FILE não existe. Rode ./install.sh primeiro.${RESET}"; exit 1; }

# Detecta docker compose (v2) ou docker-compose (v1).
if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then COMPOSE="docker-compose"
else printf '%s\n' "${RED}✗ docker compose não encontrado.${RESET}"; exit 1; fi

# Lê uma chave do .env.local (ignora comentadas).
read_env() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }

# Ativa profiles só quando há credencial (espelha o install.sh): tunnel se
# houver CF_TUNNEL_TOKEN; evolution se houver EVOLUTION_API_KEY.
PROFILES=""
[ -n "$(read_env CF_TUNNEL_TOKEN)" ] && PROFILES="$PROFILES --profile tunnel"
[ -n "$(read_env EVOLUTION_API_KEY)" ] && PROFILES="$PROFILES --profile evolution"

# Alvo: só o app (padrão) ou tudo.
TARGET="app"
[ "${1:-}" = "all" ] && TARGET=""

printf '%s\n' "${CYAN}Rebuildando ${TARGET:-todos os serviços}… (porta host: $APP_PORT)${RESET}"
# NEXT_PUBLIC_* entram no bundle no build → --env-file interpola os build args.
APP_PORT="$APP_PORT" $COMPOSE --env-file "$ENV_FILE" $PROFILES up -d --build $TARGET

# Healthcheck simples do app.
printf '%s' "${CYAN}Aguardando o app…${RESET} "
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$APP_PORT/login" 2>/dev/null || true)"
  if [ "$code" = "200" ]; then printf '%s\n' "${GREEN}OK (HTTP 200)${RESET}"; break; fi
  [ "$i" = "30" ] && { printf '%s\n' "${YELLOW}sem 200 após 30s (último: ${code:-erro}). Veja os logs.${RESET}"; }
  sleep 1
done

printf '%s\n' "${GREEN}✓ wacrm no ar → ${BOLD}http://localhost:$APP_PORT${RESET}"
printf '%s\n' "${CYAN}Logs:  $COMPOSE --env-file $ENV_FILE$PROFILES logs -f $TARGET${RESET}"
