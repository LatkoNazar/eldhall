FROM node:24-alpine AS development
WORKDIR /app/apps/landing
COPY apps/landing/package.json apps/landing/package-lock.json ./
COPY packages/analytics /app/packages/analytics
RUN npm ci --no-audit --no-fund
COPY apps/landing .
EXPOSE 5174
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
RUN setcap -r /usr/bin/caddy
COPY apps/landing/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/landing/dist /srv
ENV XDG_DATA_HOME=/tmp/caddy-data XDG_CONFIG_HOME=/tmp/caddy-config
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/landing-health || exit 1
