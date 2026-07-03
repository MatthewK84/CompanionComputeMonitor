#!/bin/sh
# Start tailscaled (userspace) when TS_AUTHKEY is provided, then the server.
set -eu

if [ -n "${TS_AUTHKEY:-}" ]; then
  echo "Starting tailscaled (userspace networking)..."
  tailscaled \
    --tun=userspace-networking \
    --statedir=/var/lib/tailscale \
    --outbound-http-proxy-listen=127.0.0.1:1055 &

  n=0
  until tailscale up \
      --authkey="${TS_AUTHKEY}" \
      --hostname="${TS_HOSTNAME:-edge-console}" \
      --accept-dns=false; do
    n=$((n + 1))
    if [ "$n" -ge 10 ]; then
      echo "tailscale up failed after 10 attempts" >&2
      exit 1
    fi
    sleep 1
  done

  export TAILSCALE_PROXY="http://127.0.0.1:1055"
  echo "Tailnet joined as ${TS_HOSTNAME:-edge-console}"
else
  echo "TS_AUTHKEY not set: relay will attempt direct connections only"
fi

exec node /app/server.mjs
