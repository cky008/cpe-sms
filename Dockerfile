FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
COPY src ./src

RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8080 18383

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${HTTP_PORT:-8080}/healthz || wget -qO- http://127.0.0.1:${WEB_PORT:-18383}/healthz || exit 1

CMD ["node", "src/cli.js", "daemon"]
