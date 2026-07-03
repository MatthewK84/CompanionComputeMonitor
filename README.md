# Edge Telemetry Console

Air-gap-ready fleet monitor for Raspberry Pi 5, NVIDIA Jetson Orin Nano, and
Raspberry Pi Zero 2 W. React console (static bundle, zero runtime network
dependencies) plus a Python-stdlib telemetry agent per device (zero pip).

```
[Console host]  --HTTP poll GET /telemetry-->  [agent/device_agent.py on each node]
 static bundle                                  Pi 5 / Orin Nano / Pi Zero 2 W
 served on LAN                                  port 8090, stdlib only
```

## Repo layout

```
src/EdgeTelemetryConsole.jsx   Console component (SIM + LIVE modes, fault board)
src/main.jsx                   Vite entry
agent/device_agent.py          Per-device telemetry agent (Python 3.10+, stdlib)
scripts/verify-airgap.mjs      CI gate: fails if dist/ references external origins
server.mjs                     Node server: static bundle + same-origin /agent relay
entrypoint.sh                  Joins the tailnet (TS_AUTHKEY) then starts the server
Dockerfile                     Build stage + Node/Tailscale runtime (Railway-ready)
railway.json                   Railway build/deploy config (healthcheck /healthz)
.github/workflows/release.yml  Tag -> build -> verify -> zip + sha256 on a Release
.github/workflows/pages-demo.yml  Optional SIM-mode demo on GitHub Pages
```

## Develop

```bash
npm ci
npm run dev        # SIM mode works immediately, no hardware needed
```

## Release flow (connected side)

```bash
git tag v1.0.0
git push origin v1.0.0
```

The release workflow builds `dist/`, runs the air-gap origin check, bundles
the agent alongside it, and attaches `edge-telemetry-console-v1.0.0.zip`
plus a `.sha256` to the GitHub Release. Pull that zip and its hash through
your approved cross-domain transfer process; verify on the far side:

```bash
sha256sum -c edge-telemetry-console-v1.0.0.zip.sha256
```

## Deploy on Railway with ZeroTier (LIVE mode via bridge relay)

BLUF: Railway containers cannot join ZeroTier directly (`zerotier-one`
needs `/dev/net/tun` and `NET_ADMIN`, which Railway does not grant, and the
userspace libzt Node bindings are unmaintained). Instead, one
ZeroTier-joined node runs this repo's `server.mjs` as a bridge relay, and
the Railway-hosted console routes LIVE polls through it.

```
[Browser] --HTTPS--> [Railway: console UI]
[Browser] --HTTPS--> [tunnel URL] --> [bridge node on ZeroTier: server.mjs]
                                          --HTTP--> device ZeroTier IPs
```

Steps:

1. Deploy the repo to Railway as before (UI hosting only; no TS_AUTHKEY
   needed).
2. Join each device to your ZeroTier network: `sudo zerotier-cli join
   <network-id>`, authorize in ZeroTier Central, note each managed IP
   (`sudo zerotier-cli listnetworks`). ZeroTier's default pools are all
   RFC 1918, so the relay allowlist already covers them.
3. Pick a bridge node on the same ZeroTier network (one of the Pis works;
   an always-on host is better). Copy `server.mjs` to it and run:
   `PORT=8082 node server.mjs` (Node 20+, no npm install needed). Without
   a `dist/` folder it runs relay-only and reports `"ui": false` on
   `/healthz`.
4. Expose the bridge over HTTPS with an outbound-only tunnel:
   `cloudflared tunnel --url http://localhost:8082` (or a named tunnel /
   Tailscale Funnel / nginx with a cert). Copy the HTTPS URL it prints.
5. In the console's CONNECT drawer, paste that URL into the RELAY field,
   flip devices to LIVE, and enter each device's ZeroTier IP and port 8090.

Verify end-to-end before the UI:

```bash
curl https://<bridge-tunnel-url>/healthz
# {"ok":true,"relay":"direct","ui":false}
curl https://<bridge-tunnel-url>/agent/<zt-device-ip>/8090/healthz
# {"ok":true}
```

Bridge hardening: the relay forwards only GET, only to RFC 1918 addresses,
only to `/telemetry` and `/healthz`. Set `CORS_ORIGIN` on the bridge to
your Railway origin (default `*`), and use ZeroTier flow rules to restrict
the bridge to port 8090 on device members.

**Simpler alternative if your browsing devices can join ZeroTier:** skip
the bridge entirely. Serve the built bundle from any ZeroTier node over
plain HTTP (`python3 -m http.server 8080 --directory dist`), join your
laptop/phone to the network (ZeroTier has iOS/Android clients), and open
`http://<zt-ip>:8080`. Over HTTP the console polls devices directly -- no
relay, no tunnel, no Railway dependency for LIVE. Keep Railway as the
public SIM demo.

### Tailscale variant

If you ever switch to Tailscale, the container CAN join the tailnet
directly (userspace mode is built into the image): set `TS_AUTHKEY` in
Railway Variables and enter tailnet IPs in the drawer with no RELAY set.
`entrypoint.sh` handles the rest.

## Deploy (enclave side)

Serve the unzipped bundle from any static server:

```bash
python3 -m http.server 8080          # or nginx: root /opt/edge-console;
```

Copy `device_agent.py` (included in the zip) to each node:

```bash
python3 device_agent.py --port 8090 --links MQTT CoT/TAK JSON/REST   # Pi 5
python3 device_agent.py --port 8090 --links RTSP MAVLink MQTT        # Orin Nano
python3 device_agent.py --port 8090 --links CoT/TAK MQTT             # Pi Zero 2 W
```

Open the console, tap CONNECT, flip nodes from SIM to LIVE, enter each
node's IP and port.

### systemd unit (recommended)

```ini
# /etc/systemd/system/edge-agent.service
[Unit]
Description=Edge telemetry agent
After=network-online.target

[Service]
ExecStart=/usr/bin/python3 /opt/edge-agent/device_agent.py --port 8090 --links MQTT CoT/TAK
Restart=always
RestartSec=3
User=telemetry
ProtectSystem=strict
ProtectHome=yes
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

## What the agent reads

| Metric        | Pi 5                              | Orin Nano                       | Pi Zero 2 W              |
|---------------|-----------------------------------|---------------------------------|--------------------------|
| Power draw    | `vcgencmd pmic_read_adc` rail sum | hwmon `power*_input` (INA3221)  | n/a (reports null)       |
| Temperature   | thermal zones (max)               | thermal zones (max)             | thermal zones (max)      |
| Memory        | /proc/meminfo                     | /proc/meminfo                   | /proc/meminfo            |
| Clock / load  | cpufreq + /proc/stat delta        | cpufreq + /proc/stat delta      | cpufreq + /proc/stat     |
| Fan           | hwmon pwm1 / fan1_input           | hwmon pwm1 / fan1_input         | fanless (null)           |
| Throttle/UV   | `vcgencmd get_throttled` bits     | reports clean                   | `vcgencmd get_throttled` |
| Link traffic  | /proc/net/dev delta, split across declared `--links` labels           |

Missing sensors return `null` rather than failing the whole sample.

## GitHub Pages demo

The `pages-demo.yml` workflow publishes a SIM-mode demo on every push to
`main`. LIVE mode does not work from Pages: the HTTPS page cannot poll
`http://` LAN agents (mixed content). Live monitoring always uses the
release bundle served inside the enclave.

## Security notes

- The agent sends `Access-Control-Allow-Origin: *`. Acceptable on an
  isolated VLAN; tighten to the console's exact origin in `make_handler()`
  if policy requires.
- The agent is read-only: no command execution, no POST routes, no writes.
- Run the agent as a non-root user; all sensor paths are world-readable on
  stock Raspberry Pi OS and JetPack.
- Restrict the agent port with nftables to the console host on shared VLANs.

## Extending

- New device: append a profile to `PROFILES` in the JSX.
- New diagnostic: append a rule to `RULES` — `applies()`, `test()`, and a
  `steps()` runbook. The fault board picks it up automatically.
