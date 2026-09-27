# syntax=docker/dockerfile:1
# Build context: repository root. Production builds are static files on S3 + CloudFront.

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
RUN yarn workspaces focus @smartdoc/web

FROM deps AS dev
COPY --chown=node:node tsconfig.base.json ./
COPY --chown=node:node apps/web apps/web
WORKDIR /app/apps/web
EXPOSE 5173
CMD ["yarn", "dev"]
