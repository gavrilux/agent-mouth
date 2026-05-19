FROM node:20-alpine AS builder
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/mcp/package.json packages/mcp/
COPY packages/mcp/tsconfig.json packages/mcp/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY packages/mcp/src packages/mcp/src
RUN pnpm --filter agent-mouth build

# --- Runtime image ---
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install pnpm for production install
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy built output and package manifest
COPY --from=builder /app/packages/mcp/dist ./dist
COPY --from=builder /app/packages/mcp/package.json ./package.json
COPY --from=builder /app/pnpm-lock.yaml ./pnpm-lock.yaml

# Install only production deps
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

EXPOSE 3000
CMD ["node", "dist/cli/index.js", "serve-http"]
