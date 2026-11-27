# The mock SATUSEHAT image (compose service `mock`). Build context: the repository root.
# Never deploy it publicly: `/__mock/*` has no auth.
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/hub/package.json apps/hub/
COPY packages/mock-satusehat/package.json packages/mock-satusehat/
COPY packages/simulator/package.json packages/simulator/
RUN pnpm install --frozen-lockfile --filter @integration-hub/mock-satusehat
COPY packages/mock-satusehat packages/mock-satusehat
RUN pnpm --filter @integration-hub/mock-satusehat build

FROM node:24-alpine
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/hub/package.json apps/hub/
COPY packages/mock-satusehat/package.json packages/mock-satusehat/
COPY packages/simulator/package.json packages/simulator/
RUN pnpm install --frozen-lockfile --prod --filter @integration-hub/mock-satusehat
COPY --from=build /repo/packages/mock-satusehat/dist packages/mock-satusehat/dist
COPY packages/mock-satusehat/world packages/mock-satusehat/world
WORKDIR /repo/packages/mock-satusehat
USER node
CMD ["node", "dist/main.js"]
