FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
# Explicit source allowlist (security audit F14); see also .dockerignore.
COPY next.config.ts tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY db ./db
RUN pnpm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3001 HOSTNAME=0.0.0.0
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
# The server itself (same path as before, so existing run commands keep working).
COPY --from=build --chown=node:node /app/.next/standalone ./.next/standalone
COPY --from=build --chown=node:node /app/.next/static ./.next/standalone/.next/static
# The migration and operator CLIs (pnpm db:migrate, db:seed-admin, db:cleanup) for release jobs.
COPY --from=build --chown=node:node /app/package.json /app/tsconfig.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/db ./db
# Mount a persistent volume here when using local document storage (DOCUMENT_STORAGE_DRIVER unset).
RUN mkdir -p /var/lib/invox/documents && chown node:node /var/lib/invox/documents && chmod 700 /var/lib/invox/documents
USER node
EXPOSE 3001
CMD ["node", ".next/standalone/server.js"]
