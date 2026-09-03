FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS builder

WORKDIR /app

# Vite inlines VITE_* at build time, so this cannot be a runtime environment variable.
# Public client-side basemap key: it ships in the JS bundle either way.
# A build environment variable of the same name overrides this default.
ARG VITE_CARTO_API_KEY="cb1_2vcr_1_934e7511f075672d3c38f898"
ENV VITE_CARTO_API_KEY=$VITE_CARTO_API_KEY

COPY . .
RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8787
ENV GEOIP_PROVIDER=ip-api
ENV IP_API_URL=http://ip-api.com

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nangman

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder --chown=nangman:nodejs /app/dist ./dist
COPY --from=builder --chown=nangman:nodejs /app/dist-server ./dist-server

USER nangman

EXPOSE 8787

CMD ["node", "dist-server/index.js"]
