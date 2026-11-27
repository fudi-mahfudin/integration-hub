# The hub image: the hub service, the worker and the one-shot migrate command
# (compose.yaml picks the command). Build context: the repository root.
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/hub/package.json apps/hub/
COPY packages/mock-satusehat/package.json packages/mock-satusehat/
COPY packages/simulator/package.json packages/simulator/
RUN pnpm install --frozen-lockfile --filter @integration-hub/hub
COPY apps/hub apps/hub
RUN pnpm --filter @integration-hub/hub build

FROM node:24-alpine
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/hub/package.json apps/hub/
COPY packages/mock-satusehat/package.json packages/mock-satusehat/
COPY packages/simulator/package.json packages/simulator/
RUN pnpm install --frozen-lockfile --prod --filter @integration-hub/hub
COPY --from=build /repo/apps/hub/dist apps/hub/dist
COPY apps/hub/seed apps/hub/seed
WORKDIR /repo/apps/hub
USER node
# Exec form: node is PID 1 and receives SIGTERM itself, so it drains (#43).
CMD ["node", "--import", "./dist/instrumentation.js", "dist/main.js"]
