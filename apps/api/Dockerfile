FROM node:24.22.2-bookworm-slim AS dependencies
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

FROM node:24.22.2-bookworm-slim AS production
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
COPY licenses ./licenses
RUN node scripts/check-licenses.mjs
RUN mkdir -p /data/dsh && chown -R node:node /data/dsh
USER node
EXPOSE 8000
CMD ["node", "dist/server.js"]
