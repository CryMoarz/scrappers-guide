# Scrapper's Digital Guide as one small container (no npm install: zero dependencies).
#
# On Project NOMAD: Supply Depot → Add a custom app, image ghcr.io/<owner>/scrappers-guide:<version>,
# port 8787, volume /opt/project-nomad/storage/scrappers-guide → /guide. See docs/NOMAD.md.
# It finds NOMAD by itself: library links, NOMAD's first-aid pages, field notes on its map.
#
# Anywhere else, from the project root:
#   docker build -f deploy/Dockerfile -t scrappers-guide .
#   docker run -d -p 8787:8787 -v /srv/scrappers-guide:/guide scrappers-guide
#
# Everything that changes lives in /guide: records in /guide/data, the hub's key and database in
# /guide/state. A new image brings its newer records, unless this copy has changed on its own.
# For production, pin the base image by digest.
FROM node:26-alpine
RUN apk add --no-cache su-exec

WORKDIR /app
COPY core ./core
COPY lib ./lib
COPY schema ./schema
COPY server ./server
COPY mcp ./mcp
COPY tools ./tools
COPY trust ./trust
COPY app ./app
COPY docs ./docs
COPY data ./seed-data
COPY package.json README.md LICENSE DATA-LICENSE.md ./

LABEL org.opencontainers.image.title="Scrapper's Guide" \
      org.opencontainers.image.description="Need a part? Find what to strip, where to look, and how to get it out safely. Works offline." \
      org.opencontainers.image.licenses="MIT AND CC-BY-SA-4.0"

ENV SDG_NAME="Scrapper’s Guide" SDG_HOST=0.0.0.0 SDG_PORT=8787 \
    SDG_DATA=/guide/data SDG_STATE=/guide/state SDG_SEED=/app/seed-data SDG_APP=/app/app/scrappers-guide.html \
    SDG_NOMAD=auto SDG_NOMAD_MARKERS=1
VOLUME ["/guide"]
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s CMD wget -qO- http://127.0.0.1:8787/health >/dev/null || exit 1

# Starts as root only to make /guide writable (Docker and NOMAD create a bind-mounted folder as
# root), then runs the guide as the unprivileged node user.
CMD ["sh", "-c", "mkdir -p /guide && chown -R node:node /guide && exec su-exec node node server/hub.js"]
