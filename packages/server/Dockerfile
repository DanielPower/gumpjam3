# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f packages/server/Dockerfile .

FROM node:24-slim AS build
RUN npm install --global pnpm@12.4.1
WORKDIR /repo

# Install dependencies first so they're cached until a manifest changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/game/package.json packages/game/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@stairs/server..."

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
RUN pnpm --filter @stairs/server typecheck \
    && pnpm --filter @stairs/server test \
    && pnpm --filter @stairs/server build \
    && pnpm --filter @stairs/server deploy --prod /deploy

FROM node:24-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/scores.db \
    LEVELS_DIR=/app/levels
WORKDIR /app

# The bundle keeps box3d.js external so it can load its .wasm from node_modules.
COPY --from=build /deploy/package.json ./
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /deploy/dist ./dist
COPY --from=build /repo/packages/shared/levels/*.map ./levels/

RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s \
    CMD node -e "fetch('http://localhost:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]
