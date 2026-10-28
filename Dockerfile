# Stage 1: Strict TypeScript + daisyUI v5 / Tailwind v4 build
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.test.json tsconfig.web.json ./
RUN npm ci --ignore-scripts

COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Stage 2: Minimal zero-dependency runtime image
FROM node:22-alpine AS runner

RUN apk add --no-cache su-exec

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh /app/dist/cli.js && mkdir -p /app/data && chown -R node:node /app

EXPOSE 18383

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD if [ "${WEB_ENABLED:-true}" = "true" ] && [ "${WEB_PORT:-18383}" != "0" ]; then \
        wget -qO- http://127.0.0.1:${WEB_PORT:-18383}/healthz >/dev/null || exit 1; \
      elif [ "${HTTP_PORT:-0}" != "0" ]; then \
        wget -qO- http://127.0.0.1:${HTTP_PORT}/healthz >/dev/null || exit 1; \
      else \
        pgrep -f "dist/cli.js" >/dev/null || exit 1; \
      fi

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/cli.js", "daemon"]
