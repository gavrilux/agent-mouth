FROM node:20-alpine AS builder
WORKDIR /app

# Native build tools needed to compile better-sqlite3 in workspace
RUN apk add --no-cache python3 make g++

# Install pnpm — pinned to v9 (pnpm v11 requires Node 22+, we're on Node 20)
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy workspace manifests first (pnpm needs all of them for lockfile resolution)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/tsconfig.json packages/core/
COPY packages/storage-supabase/package.json packages/storage-supabase/tsconfig.json packages/storage-supabase/
COPY packages/storage-sqlite/package.json packages/storage-sqlite/tsconfig.json packages/storage-sqlite/
COPY packages/storage-postgres/package.json packages/storage-postgres/tsconfig.json packages/storage-postgres/
COPY packages/transport-telegram/package.json packages/transport-telegram/tsconfig.json packages/transport-telegram/
COPY packages/agent/package.json packages/agent/tsconfig.json packages/agent/
COPY packages/agent-runtime/package.json packages/agent-runtime/tsconfig.json packages/agent-runtime/
COPY packages/agent-memory/package.json packages/agent-memory/tsconfig.json packages/agent-memory/
COPY packages/agent-guardrails/package.json packages/agent-guardrails/tsconfig.json packages/agent-guardrails/
COPY packages/agent-notes-updater/package.json packages/agent-notes-updater/tsconfig.json packages/agent-notes-updater/
COPY packages/queue-pgboss/package.json packages/queue-pgboss/tsconfig.json packages/queue-pgboss/
# Phase 3 packages
COPY packages/embeddings/package.json packages/embeddings/tsconfig.json packages/embeddings/
COPY packages/web-search/package.json packages/web-search/tsconfig.json packages/web-search/
COPY packages/vector-store/package.json packages/vector-store/tsconfig.json packages/vector-store/
COPY packages/knowledge-source/package.json packages/knowledge-source/tsconfig.json packages/knowledge-source/
COPY packages/agent-tools/package.json packages/agent-tools/tsconfig.json packages/agent-tools/
COPY packages/api/package.json packages/api/tsconfig.json packages/api/
COPY apps/cli/package.json apps/cli/tsconfig.json apps/cli/

# Install all dependencies (needed for full workspace build)
RUN pnpm install --frozen-lockfile

# Copy sources and build every package in topological order
COPY packages/core/src packages/core/src
COPY packages/storage-supabase/src packages/storage-supabase/src
COPY packages/storage-sqlite/src packages/storage-sqlite/src
COPY packages/storage-postgres/src packages/storage-postgres/src
COPY packages/transport-telegram/src packages/transport-telegram/src
COPY packages/agent/src packages/agent/src
COPY packages/agent-runtime/src packages/agent-runtime/src
COPY packages/agent-memory/src packages/agent-memory/src
COPY packages/agent-guardrails/src packages/agent-guardrails/src
COPY packages/agent-notes-updater/src packages/agent-notes-updater/src
COPY packages/queue-pgboss/src packages/queue-pgboss/src
# Phase 3 sources
COPY packages/embeddings/src packages/embeddings/src
COPY packages/web-search/src packages/web-search/src
COPY packages/vector-store/src packages/vector-store/src
COPY packages/knowledge-source/src packages/knowledge-source/src
COPY packages/agent-tools/src packages/agent-tools/src
COPY packages/api/src packages/api/src
COPY apps/cli/src apps/cli/src
RUN pnpm -r build

# Production bundle for apps/cli only — excludes better-sqlite3 (not a transitive dep)
RUN pnpm --filter ./apps/cli deploy --prod /prod

# --- Runtime image ---
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy pruned production package (workspace deps already embedded in node_modules)
COPY --from=builder /prod/node_modules ./node_modules
COPY --from=builder /prod/package.json ./package.json
COPY --from=builder /app/apps/cli/dist ./dist

EXPOSE 3000

# Use exec form so SIGTERM reaches Node directly (graceful shutdown)
CMD ["node", "dist/index.js", "serve-http"]
