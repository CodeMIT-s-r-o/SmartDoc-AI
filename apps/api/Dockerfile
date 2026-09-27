# syntax=docker/dockerfile:1
# Build context: repository root.

FROM node:24-slim AS deps
ENV CI=true
RUN mkdir /app && chown node:node /app
USER node
WORKDIR /app
COPY --chown=node:node package.json yarn.lock .yarnrc.yml ./
COPY --chown=node:node .yarn/releases .yarn/releases
# Every workspace manifest is needed for an immutable install, even when focusing on one.
COPY --chown=node:node apps/api/package.json apps/api/
COPY --chown=node:node apps/web/package.json apps/web/
COPY --chown=node:node packages/contracts/package.json packages/contracts/
COPY --chown=node:node infra/cdk/package.json infra/cdk/
RUN yarn workspaces focus @smartdoc/api

FROM deps AS dev
# `nest start --watch` stops the previous process via tree-kill, which needs `ps` (missing in slim).
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/*
USER node
COPY --chown=node:node tsconfig.base.json ./
COPY --chown=node:node apps/api apps/api
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["yarn", "dev"]
