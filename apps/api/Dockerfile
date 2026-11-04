FROM docker.io/library/node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS development
COPY . .
USER node
CMD ["npm", "run", "dev"]

FROM dependencies AS build
COPY . .
RUN npm run build

FROM docker.io/library/node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS production
ARG ELDHALL_VERSION=""
ARG ELDHALL_SOURCE_REVISION=""
LABEL io.eldhall.project.license="Apache-2.0" \
      io.eldhall.project.license-scope="Project-authored software; see /app/licenses/LICENSING.md for third-party terms"
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --chown=node:node runtime ./runtime
COPY migrations ./migrations
COPY scripts ./scripts
COPY bin ./bin
COPY licenses ./licenses
RUN node scripts/check-licenses.mjs
RUN node scripts/write-build-info.mjs --version "$ELDHALL_VERSION" --source-revision "$ELDHALL_SOURCE_REVISION" \
    && chmod 755 bin/eldhall.mjs \
    && ln -s /app/bin/eldhall.mjs /usr/local/bin/eldhall
RUN mkdir -p /data/dsh && chown -R node:node /data/dsh
USER node
EXPOSE 8000
CMD ["node", "dist/server.js"]
