# Stage 1: build the static bundle and run the air-gap origin gate.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm run verify:airgap

# Stage 2: Node server (static + same-origin agent relay) with Tailscale
# binaries for reaching devices on a tailnet from Railway.
FROM node:20-alpine
RUN apk add --no-cache ca-certificates
COPY --from=tailscale/tailscale:stable /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY --from=tailscale/tailscale:stable /usr/local/bin/tailscale /usr/local/bin/tailscale
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server.mjs entrypoint.sh ./
# Re-assert the exec bit (lost by some zip/Windows/git paths) AND invoke via
# sh explicitly: the node image's entrypoint wrapper prepends `node` to any
# CMD it cannot resolve as an executable, which would parse this shell
# script as JavaScript.
RUN chmod +x /app/entrypoint.sh && mkdir -p /var/lib/tailscale
ENV PORT=8080
EXPOSE 8080
CMD ["/bin/sh", "/app/entrypoint.sh"]
