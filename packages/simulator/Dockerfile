# The source simulator image (compose service `simulator`): runs one batch and exits.
# Build context: the repository root. It reads the world dataset from the mock's package, so it
# runs from source with tsx, as the mock's `./world` export is TypeScript.
FROM node:24-alpine
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/hub/package.json apps/hub/
COPY packages/mock-satusehat/package.json packages/mock-satusehat/
COPY packages/simulator/package.json packages/simulator/
RUN pnpm install --frozen-lockfile --prod --filter "@integration-hub/simulator..."
COPY packages/mock-satusehat/src packages/mock-satusehat/src
COPY packages/mock-satusehat/world packages/mock-satusehat/world
COPY packages/mock-satusehat/tsconfig.json packages/mock-satusehat/
COPY packages/simulator/src packages/simulator/src
COPY packages/simulator/tsconfig.json packages/simulator/
WORKDIR /repo/packages/simulator
USER node
CMD ["node", "--import", "tsx", "src/main.ts"]
