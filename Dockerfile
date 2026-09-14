# syntax=docker/dockerfile:1

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS base

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

FROM base AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
COPY .env.example prisma.config.js ./
COPY prisma ./prisma
COPY src/config/env.js ./src/config/env.js

RUN npm ci && npm cache clean --force

FROM dependencies AS tooling

COPY --chown=node:node src ./src

USER node

CMD ["npm", "run", "db:migrate:deploy"]

FROM dependencies AS production-dependencies

RUN npm prune --omit=dev --ignore-scripts

FROM base AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/generated ./generated
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

RUN mkdir -p /app/storage && chown node:node /app/storage

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/health`).then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "src/server.js"]
