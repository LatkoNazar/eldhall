FROM node:24-alpine AS development
WORKDIR /app/apps/frontend
COPY apps/frontend/package.json apps/frontend/package-lock.json ./
COPY packages/analytics /app/packages/analytics
RUN npm ci --no-audit --no-fund
COPY apps/frontend .
EXPOSE 5173
CMD ["npm", "run", "dev"]

FROM development AS build
ARG PUBLIC_APP_URL
ARG PUBLIC_UMAMI_SCRIPT_URL
ARG PUBLIC_UMAMI_WEBSITE_ID
ARG PUBLIC_UMAMI_DOMAINS
ENV PUBLIC_APP_URL=$PUBLIC_APP_URL \
    PUBLIC_UMAMI_SCRIPT_URL=$PUBLIC_UMAMI_SCRIPT_URL \
    PUBLIC_UMAMI_WEBSITE_ID=$PUBLIC_UMAMI_WEBSITE_ID \
    PUBLIC_UMAMI_DOMAINS=$PUBLIC_UMAMI_DOMAINS
RUN npm run build

FROM caddy:2.11.7-alpine AS production
LABEL io.eldhall.project.license="Apache-2.0" \
      io.eldhall.project.license-scope="Project-authored software; see /srv/licenses/LICENSING.md for third-party terms"
RUN setcap -r /usr/bin/caddy
COPY apps/frontend/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/frontend/dist /srv
# TLS is terminated by the outer proxy. Keep all runtime writes in /tmp so
# Compose may make the image filesystem read-only and mount /tmp as tmpfs.
ENV XDG_DATA_HOME=/tmp/caddy-data XDG_CONFIG_HOME=/tmp/caddy-config
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/frontend-health || exit 1
