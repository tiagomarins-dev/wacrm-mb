# syntax=docker/dockerfile:1

# ============================================================
# wacrm — imagem Docker multi-stage para Next.js 16 (standalone)
# Banco é Supabase (externo) — nenhum Postgres sobe aqui.
# ============================================================

# ---- Stage 1: deps — instala dependências em camada cacheável ----
FROM node:22-alpine AS deps
# libc6-compat: alguns pacotes nativos esperam glibc no Alpine
RUN apk add --no-cache libc6-compat
WORKDIR /app
# Copia só os manifests primeiro para aproveitar o cache do Docker:
# enquanto package*.json não mudar, esta camada não reinstala.
COPY package.json package-lock.json ./
RUN npm ci

# ---- Stage 2: builder — compila o app ----
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Variáveis NEXT_PUBLIC_* são inlinadas no bundle do browser em build-time
# (não em runtime). Precisam existir aqui, senão o prerender das páginas
# "use client" que criam o client Supabase quebra. São públicas por
# natureza (URL + anon key), então embuti-las na imagem é o esperado.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL

# Telemetria do Next desligada no build
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- Stage 3: runner — imagem final enxuta de produção ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Usuário sem privilégios — não rodar como root em produção
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Assets públicos (imagens, fontes, etc.)
COPY --from=builder /app/public ./public

# Saída standalone: server.js + node_modules mínimo já vêm prontos.
# A pasta static não entra no standalone — precisa ser copiada à parte.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

# Healthcheck simples — porta respondendo
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ >/dev/null 2>&1 || exit 1

# server.js é o entrypoint gerado pelo build standalone do Next
CMD ["node", "server.js"]
