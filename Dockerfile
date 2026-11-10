FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3001 HOSTNAME=0.0.0.0
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
# Include the migration CLI and its dependencies for a separate release migration step.
COPY --from=build --chown=node:node /app /app
COPY --from=build --chown=node:node /app/.next/static /app/.next/standalone/.next/static
USER node
EXPOSE 3001
CMD ["node", ".next/standalone/server.js"]
