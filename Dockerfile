FROM node:20-alpine AS builder
WORKDIR /app

# Install pnpm — pinned to v9 (pnpm v11 requires Node 22+, we're on Node 20)
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/mcp/package.json packages/mcp/
COPY packages/mcp/tsconfig.json packages/mcp/

# Install all dependencies (needed for build)
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY packages/mcp/src packages/mcp/src
RUN pnpm --filter agent-mouth build

# Prune to production-only deps in place (keeps workspace layout intact)
RUN pnpm --filter agent-mouth deploy --prod /prod

# --- Runtime image ---
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy pruned production package (includes node_modules and dist)
COPY --from=builder /prod/node_modules ./node_modules
COPY --from=builder /prod/package.json ./package.json
COPY --from=builder /app/packages/mcp/dist ./dist

EXPOSE 3000

# Use exec form so SIGTERM reaches Node directly (graceful shutdown)
CMD ["node", "dist/cli/index.js", "serve-http"]
