# syntax=docker/dockerfile:1.7
# Aletheia UI — Vite build served by nginx, proxying the Studio API.
# Bundles every font, icon and script: the UI loads nothing from the internet (spec §13.6).
ARG NODE_VERSION=22
ARG DEBIAN_SUITE=bookworm
ARG NGINX_VERSION=1.27-alpine

FROM node:${NODE_VERSION}-${DEBIAN_SUITE} AS build
WORKDIR /app
ENV npm_config_fund=false npm_config_audit=false NEXT_TELEMETRY_DISABLED=1
COPY frontend/package.json frontend/package-lock.jso[n] frontend/pnpm-lock.yam[l] ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY frontend ./
ARG ALETHEIA_VERSION=dev
ENV VITE_ALETHEIA_VERSION=${ALETHEIA_VERSION}
RUN npm run build

FROM nginx:${NGINX_VERSION}
RUN rm -f /etc/nginx/conf.d/default.conf
COPY docker/ui/nginx.conf.template /etc/nginx/templates/aletheia.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
ENV ALETHEIA_STUDIO_UPSTREAM=http://aletheia-studio:8081 \
    ALETHEIA_GRAFANA_UPSTREAM=http://grafana:3000
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz | grep -q ok || exit 1
