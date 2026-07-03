# Edge Telemetry Console

Air-gap-ready fleet monitor for Raspberry Pi 5, NVIDIA Jetson Orin Nano, and
Raspberry Pi Zero 2 W. React console with a Python-stdlib telemetry agent per device.

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
Dockerfile                     Multi-stage build -> nginx static serve (Railway-ready)
nginx.conf.template            Listens on Railway's injected $PORT
railway.json                   Railway build/deploy config
.github/workflows/release.yml  Tag -> build -> verify -> zip + sha256 on a Release
.github/workflows/pages-demo.yml  Optional SIM-mode demo on GitHub Pages
```

## Develop

```bash
npm ci
npm run dev        # SIM mode works immediately, no hardware needed
```

## Release flow

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

## Deploy on Railway

The repo ships a multi-stage `Dockerfile` and `railway.json`, so deployment
is connect-and-go:

1. Push this repo to GitHub.
2. In Railway: New Project -> Deploy from GitHub repo -> select it.
3. Railway detects the Dockerfile, builds (the air-gap gate runs inside the
   build and fails the deploy if the bundle picks up an external origin),
   and serves the console on your `*.up.railway.app` domain.

Every push to the connected branch redeploys automatically. Attach a custom
domain in Railway settings if you want one.

**LIVE mode from a Railway-hosted console:** the page is HTTPS, so browsers
block polling plain `http://` LAN agents, and LAN IPs are
not reachable from the internet anyway. Two working patterns:

- Put the agents behind an HTTPS tunnel or reverse proxy (Tailscale Funnel,
  cloudflared, or nginx with a cert) and enter the full URL in the CONNECT
  drawer -- hosts with an explicit `https://` scheme are used as-is.
- Or treat the Railway deployment as the SIM-mode demo, and serve the same
  release bundle inside the enclave for live monitoring (see below).

## Deploy

Serve the unzipped bundle from any static server:

```bash
python3 -m http.server 8080          # or nginx: root /opt/edge-console;
```

Copy `device_agent.py` to each node:

```bash
python3 device_agent.py --port 8090 --links MQTT CoT/TAK JSON/REST   # Pi 5
python3 device_agent.py --port 8090 --links RTSP MAVLink MQTT        # Orin Nano
python3 device_agent.py --port 8090 --links CoT/TAK MQTT             # Pi Zero 2 W
```

Open the console, tap CONNECT, flip nodes from SIM to LIVE, enter each
node's IP and port.

### systemd unit

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
