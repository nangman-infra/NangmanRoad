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

# The PeeringDB-derived files under server/data come in with the tree. The pipeline builds
# them once, on the agent, before this image (npm run data:refresh -- peeringdb): fetched in
# here they were requested once per platform, which is past PeeringDB's rate limit, and the
# image shipped without them. They are never committed (acceptable use policy).
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
# What the server keeps between deployments (the site-code candidate list). The named volume
# compose mounts here takes this directory's owner when it is first created, so the
# unprivileged server can write to it.
RUN mkdir -p /app/state && chown nangman:nodejs /app/state

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder --chown=nangman:nodejs /app/dist ./dist
COPY --from=builder --chown=nangman:nodejs /app/dist-server ./dist-server
COPY --from=builder --chown=nangman:nodejs /app/server/data ./server/data

USER nangman

EXPOSE 8787

CMD ["node", "dist-server/index.js"]
