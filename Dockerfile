# Chart Desk runtime image
# Build the web assets on the host first: `npm run build`
# Then: `docker build -t chart-desk:0.1.0 .`
# http-proxy is copied from the host (Docker host may not resolve npm DNS).
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173

RUN addgroup -S desk && adduser -S desk -G desk

COPY dist ./dist
COPY server.mjs feeds.mjs ./
COPY package.json ./
# Minimal runtime deps for LBank reverse proxy (no npm install in image)
COPY node_modules/http-proxy ./node_modules/http-proxy
COPY node_modules/eventemitter3 ./node_modules/eventemitter3
COPY node_modules/requires-port ./node_modules/requires-port
COPY node_modules/follow-redirects ./node_modules/follow-redirects

RUN mkdir -p /app/data && chown -R desk:desk /app

USER desk
EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
