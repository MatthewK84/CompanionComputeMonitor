/**
 * EDGE TELEMETRY CONSOLE
 * Air-gap-ready fleet monitor for Raspberry Pi 5, NVIDIA Jetson Orin Nano,
 * and Raspberry Pi Zero 2 W.
 *
 * Design constraints honored for air-gapped deployment:
 *  - Zero runtime network dependencies: no CDN scripts, no web fonts,
 *    no external images. System font stacks only.
 *  - No browser storage APIs. All state is in memory.
 *  - LIVE mode polls a stdlib-only Python agent on each device:
 *      GET http://<host>:<port>/telemetry  ->  JSON (see device_agent.py)
 *  - SIM mode generates realistic telemetry with fault injection so the
 *    console can be exercised with no hardware attached.
 *
 * Coding standards: Power-of-Ten-derived JS rules. const-only bindings,
 * guard clauses, no prototype mutation, no floating promises, functions
 * kept small, data shapes declared via JSDoc typedefs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------------------------------------------ */
/* Data shapes                                                         */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} LinkStat
 * @property {string} proto   Protocol / data type on the wire (e.g. "MQTT")
 * @property {number} kbps    Current throughput, kilobits per second
 * @property {boolean} active Whether traffic was seen this tick
 */

/**
 * @typedef {Object} Sample
 * @property {number} ts          Epoch ms
 * @property {number} powerW      Instantaneous board power draw, watts
 * @property {number} memUsedMb   Memory in use, MiB
 * @property {number} memTotalMb  Total memory, MiB
 * @property {number} clockMhz    Current CPU clock, MHz
 * @property {number} cpuLoadPct  CPU load, 0-100
 * @property {number} tempC       SoC temperature, Celsius
 * @property {number|null} fanPct Fan duty, 0-100, or null when no fan
 * @property {number|null} fanRpm Fan speed, or null when no fan
 * @property {boolean} throttled  Firmware reports active throttling
 * @property {boolean} undervolt  Firmware reports undervoltage (Pi)
 * @property {LinkStat[]} links   Data links currently observed
 */

/**
 * @typedef {Object} DeviceProfile
 * @property {string} id
 * @property {string} label
 * @property {string} designator   Faceplate short code
 * @property {number} maxPowerW    Gauge full-scale, watts
 * @property {number} idlePowerW
 * @property {number} warnTempC
 * @property {number} throttleTempC
 * @property {number} memTotalMb
 * @property {number} maxClockMhz
 * @property {boolean} hasFan
 * @property {number} maxFanRpm
 * @property {string[]} expectedLinks
 */

/**
 * @typedef {Object} DeviceConfig
 * @property {string} key        Unique instance key
 * @property {string} profileId
 * @property {"SIM"|"LIVE"} mode
 * @property {string} host
 * @property {number} port
 */

/**
 * @typedef {Object} Fault
 * @property {string} id
 * @property {"WARN"|"CRIT"|"INFO"} severity
 * @property {string} title
 * @property {string} detail
 * @property {string[]} steps    Runbook steps, may include shell commands
 */

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const TICK_MS = 1000;
const HISTORY_LEN = 90;
const FETCH_TIMEOUT_MS = 800;

/** @type {readonly DeviceProfile[]} */
const PROFILES = Object.freeze([
  Object.freeze({
    id: "pi5",
    label: "Raspberry Pi 5",
    designator: "RPI-5",
    maxPowerW: 12,
    idlePowerW: 2.7,
    warnTempC: 75,
    throttleTempC: 85,
    memTotalMb: 8192,
    maxClockMhz: 2400,
    hasFan: true,
    maxFanRpm: 8000,
    expectedLinks: Object.freeze(["MQTT", "CoT/TAK", "JSON/REST"]),
  }),
  Object.freeze({
    id: "orin-nano",
    label: "Jetson Orin Nano",
    designator: "ORIN-N",
    maxPowerW: 25,
    idlePowerW: 5.0,
    warnTempC: 85,
    throttleTempC: 96,
    memTotalMb: 8192,
    maxClockMhz: 1510,
    hasFan: true,
    maxFanRpm: 6000,
    expectedLinks: Object.freeze(["RTSP", "MAVLink", "MQTT"]),
  }),
  Object.freeze({
    id: "pi-zero-2w",
    label: "Raspberry Pi Zero 2 W",
    designator: "RPI-Z2W",
    maxPowerW: 3,
    idlePowerW: 0.7,
    warnTempC: 70,
    throttleTempC: 80,
    memTotalMb: 512,
    maxClockMhz: 1000,
    hasFan: false,
    maxFanRpm: 0,
    expectedLinks: Object.freeze(["CoT/TAK", "MQTT"]),
  }),
]);

/** Theme tokens. Instrumentation triad + cyan data trace on graphite. */
const T = Object.freeze({
  bg: "#101418",
  panel: "#161C22",
  panelDeep: "#12171C",
  edge: "#242E38",
  edgeSoft: "#1C242C",
  ink: "#C9D3DC",
  dim: "#6B7885",
  faint: "#414D58",
  data: "#5FB6CF",
  ok: "#57BB87",
  warn: "#E2A73E",
  crit: "#DE6A55",
  mono: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, Menlo, monospace',
  sans: '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", sans-serif',
});

const SEVERITY_COLOR = Object.freeze({
  CRIT: T.crit,
  WARN: T.warn,
  INFO: T.data,
});

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                  */
/* ------------------------------------------------------------------ */

/** @param {number} v @param {number} lo @param {number} hi @returns {number} */
function clamp(v, lo, hi) {
  if (v < lo) {
    return lo;
  }
  if (v > hi) {
    return hi;
  }
  return v;
}

/** @param {string} id @returns {DeviceProfile} */
function profileById(id) {
  const found = PROFILES.find((p) => p.id === id);
  if (found === undefined) {
    throw new Error(`Unknown profile id: ${id}`);
  }
  return found;
}

/** @param {number} n @param {number} digits @returns {string} */
function fx(n, digits) {
  if (!Number.isFinite(n)) {
    return "--";
  }
  return n.toFixed(digits);
}

/* ------------------------------------------------------------------ */
/* Simulation engine (SIM mode / demo without hardware)                */
/* ------------------------------------------------------------------ */

const FAULT_KINDS = Object.freeze([
  "THERMAL",
  "UNDERVOLT",
  "MEM_LEAK",
  "FAN_STALL",
  "LINK_SILENT",
]);

/** @param {DeviceProfile} p */
function makeSimState(p) {
  return {
    load: 25 + Math.random() * 20,
    temp: 45 + Math.random() * 8,
    memUsed: p.memTotalMb * (0.35 + Math.random() * 0.1),
    fault: null,
    ticksToFault: 40 + Math.floor(Math.random() * 80),
    silentLink: null,
  };
}

/** @param {DeviceProfile} p @returns {string} */
function pickFaultKind(p) {
  const pool = FAULT_KINDS.filter((k) => {
    if (k === "UNDERVOLT") {
      return p.id.startsWith("pi");
    }
    if (k === "FAN_STALL") {
      return p.hasFan;
    }
    return true;
  });
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx] ?? "THERMAL";
}

/** Advance fault lifecycle in place. @param {object} s @param {DeviceProfile} p */
function stepFaultLifecycle(s, p) {
  if (s.fault !== null) {
    s.fault.ticksLeft -= 1;
    if (s.fault.ticksLeft <= 0) {
      s.fault = null;
      s.silentLink = null;
      s.ticksToFault = 60 + Math.floor(Math.random() * 120);
    }
    return;
  }
  s.ticksToFault -= 1;
  if (s.ticksToFault > 0) {
    return;
  }
  const kind = pickFaultKind(p);
  s.fault = { kind, ticksLeft: 18 + Math.floor(Math.random() * 20) };
  if (kind === "LINK_SILENT") {
    const idx = Math.floor(Math.random() * p.expectedLinks.length);
    s.silentLink = p.expectedLinks[idx] ?? null;
  }
}

/** @param {object} s @param {DeviceProfile} p @returns {number} */
function simTargetLoad(s, p) {
  if (s.fault?.kind === "THERMAL") {
    return 96;
  }
  if (s.fault?.kind === "MEM_LEAK") {
    return 70;
  }
  return 20 + 35 * Math.abs(Math.sin(Date.now() / 45000 + p.maxPowerW));
}

/** @param {object} s @param {DeviceProfile} p @returns {LinkStat[]} */
function simLinks(s, p) {
  return p.expectedLinks.map((proto) => {
    const silenced = s.silentLink === proto;
    const base = proto === "RTSP" ? 4200 : proto === "MAVLink" ? 90 : 240;
    const kbps = silenced ? 0 : base * (0.6 + Math.random() * 0.8);
    return { proto, kbps: Math.round(kbps), active: !silenced };
  });
}

/**
 * One simulation tick. Mutates the per-device sim state held in a ref
 * (deliberate, ref-scoped, never shared) and returns an immutable Sample.
 * @param {object} s @param {DeviceProfile} p @returns {Sample}
 */
function stepSim(s, p) {
  stepFaultLifecycle(s, p);
  const target = simTargetLoad(s, p);
  s.load = clamp(s.load + (target - s.load) * 0.15 + (Math.random() - 0.5) * 6, 2, 100);

  const fanStalled = s.fault?.kind === "FAN_STALL";
  const cooling = p.hasFan && !fanStalled ? 1.0 : 0.45;
  const tempTarget = 42 + (s.load / 100) * (p.throttleTempC - 30) / cooling;
  s.temp = clamp(s.temp + (tempTarget - s.temp) * 0.08 + (Math.random() - 0.5), 35, p.throttleTempC + 8);

  const leak = s.fault?.kind === "MEM_LEAK" ? p.memTotalMb * 0.012 : 0;
  const memTarget = p.memTotalMb * (0.35 + 0.3 * (s.load / 100));
  s.memUsed = clamp(s.memUsed + (memTarget - s.memUsed) * 0.05 + leak, 64, p.memTotalMb * 0.985);

  const throttled = s.temp >= p.throttleTempC || s.fault?.kind === "UNDERVOLT";
  const clock = throttled ? p.maxClockMhz * 0.55 : p.maxClockMhz * (0.6 + 0.4 * (s.load / 100));
  const power = p.idlePowerW + (p.maxPowerW - p.idlePowerW) * Math.pow(s.load / 100, 1.3);
  const fanPct = !p.hasFan ? null : fanStalled ? 0 : clamp(Math.round(((s.temp - 40) / 45) * 100), 0, 100);

  return Object.freeze({
    ts: Date.now(),
    powerW: power * (0.97 + Math.random() * 0.06),
    memUsedMb: Math.round(s.memUsed),
    memTotalMb: p.memTotalMb,
    clockMhz: Math.round(clock),
    cpuLoadPct: Math.round(s.load),
    tempC: s.temp,
    fanPct,
    fanRpm: fanPct === null ? null : Math.round((fanPct / 100) * p.maxFanRpm),
    throttled,
    undervolt: s.fault?.kind === "UNDERVOLT",
    links: simLinks(s, p),
  });
}

/* ------------------------------------------------------------------ */
/* Live-mode transport                                                 */
/* ------------------------------------------------------------------ */

/** @param {unknown} raw @param {DeviceProfile} p @returns {Sample} */
function normalizeSample(raw, p) {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Agent returned non-object payload");
  }
  const r = /** @type {Record<string, unknown>} */ (raw);
  const num = (k, fallback) => (typeof r[k] === "number" ? /** @type {number} */ (r[k]) : fallback);
  const links = Array.isArray(r.links)
    ? r.links
        .filter((l) => typeof l === "object" && l !== null)
        .map((l) => ({
          proto: String(l.proto ?? "UNKNOWN"),
          kbps: typeof l.kbps === "number" ? l.kbps : 0,
          active: Boolean(l.active),
        }))
    : [];
  return Object.freeze({
    ts: num("ts", Date.now()),
    powerW: num("power_w", NaN),
    memUsedMb: num("mem_used_mb", NaN),
    memTotalMb: num("mem_total_mb", p.memTotalMb),
    clockMhz: num("clock_mhz", NaN),
    cpuLoadPct: num("cpu_load_pct", NaN),
    tempC: num("temp_c", NaN),
    fanPct: typeof r.fan_pct === "number" ? r.fan_pct : null,
    fanRpm: typeof r.fan_rpm === "number" ? r.fan_rpm : null,
    throttled: Boolean(r.throttled),
    undervolt: Boolean(r.undervolt),
    links,
  });
}

/**
 * Build the agent base URL. A bare host defaults to http:// (LAN enclave
 * case). A host entered with an explicit scheme (e.g. an HTTPS tunnel or
 * reverse proxy in front of the agent) is used as-is, which is required
 * when this console is itself served over HTTPS (e.g. Railway).
 * @param {DeviceConfig} cfg @returns {string}
 */
function agentBaseUrl(cfg) {
  const hasScheme = cfg.host.startsWith("http://") || cfg.host.startsWith("https://");
  const base = hasScheme ? cfg.host : `http://${cfg.host}`;
  return `${base}:${cfg.port}`;
}

/**
 * Poll one device agent with a hard timeout.
 * @param {DeviceConfig} cfg @param {DeviceProfile} p @returns {Promise<Sample>}
 */
async function fetchLiveSample(cfg, p) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${agentBaseUrl(cfg)}/telemetry`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${cfg.host}`);
    }
    const raw = await res.json();
    return normalizeSample(raw, p);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Diagnostics rules engine                                            */
/* ------------------------------------------------------------------ */

/**
 * Each rule: applies(profile) gate, test(sample, profile) predicate,
 * and a concrete runbook. Deterministic and offline by design.
 */
const RULES = Object.freeze([
  {
    id: "THERMAL_CRIT",
    severity: "CRIT",
    title: "Thermal throttle active",
    applies: () => true,
    test: (s, p) => s.tempC >= p.throttleTempC || s.throttled,
    detail: (s, p) => `SoC at ${fx(s.tempC, 1)}°C (throttle point ${p.throttleTempC}°C). Clocks are being capped.`,
    steps: (p) =>
      p.id === "orin-nano"
        ? [
            "Confirm throttle state: sudo tegrastats --interval 1000",
            "Check power/thermal profile: sudo nvpmodel -q  (drop to a lower-watt mode if margin is gone)",
            "Verify fan control: cat /sys/devices/platform/*pwm-fan*/hwmon/hwmon*/pwm1",
            "Inspect heatsink seating and airflow path; re-paste if delta-T from ambient exceeds ~55°C at idle-adjacent load",
          ]
        : [
            "Read firmware flags: vcgencmd get_throttled  (0x0 = clean; bit 2 = throttling now)",
            "Check governor and current clock: vcgencmd measure_clock arm",
            "Verify heatsink/active-cooler contact and case airflow",
            "Reduce sustained load or duty-cycle the workload until temp falls below warn threshold",
          ],
  },
  {
    id: "THERMAL_WARN",
    severity: "WARN",
    title: "Temperature approaching throttle",
    applies: () => true,
    test: (s, p) => s.tempC >= p.warnTempC && s.tempC < p.throttleTempC && !s.throttled,
    detail: (s, p) => `SoC at ${fx(s.tempC, 1)}°C, within ${fx(p.throttleTempC - s.tempC, 1)}°C of throttle.`,
    steps: () => [
      "Trend the temperature sparkline: rising slope under steady load indicates a cooling problem, not a workload problem",
      "Check fan duty is tracking temperature (fan gauge on this card)",
      "Pre-emptively shed non-essential workloads before the throttle point",
    ],
  },
  {
    id: "UNDERVOLT",
    severity: "CRIT",
    title: "Undervoltage detected",
    applies: (p) => p.id.startsWith("pi"),
    test: (s) => s.undervolt,
    detail: () => "Firmware reports supply rail below 4.63 V. Brownouts corrupt SD cards and drop USB devices.",
    steps: (p) => [
      "Confirm: vcgencmd get_throttled  (bit 0 = undervoltage now, bit 16 = has occurred)",
      p.id === "pi5"
        ? "Use the official 27 W (5 V / 5 A) USB-C PD supply; most phone chargers cannot negotiate 5 A"
        : "Use a supply rated ≥ 2.5 A with a short, heavy-gauge micro-USB cable",
      "Remove unpowered USB peripherals and retest",
      "If powered from a battery/BEC, scope the 5 V rail under load for sag",
    ],
  },
  {
    id: "MEM_PRESSURE",
    severity: "WARN",
    title: "Memory pressure",
    applies: () => true,
    test: (s) => s.memTotalMb > 0 && s.memUsedMb / s.memTotalMb >= 0.9,
    detail: (s) => `${s.memUsedMb} / ${s.memTotalMb} MiB in use (${fx((100 * s.memUsedMb) / s.memTotalMb, 0)}%). OOM-killer risk.`,
    steps: () => [
      "Identify the consumer: ps -eo pid,comm,rss --sort=-rss | head",
      "Check for a leak: watch the RSS of the top process over 5 minutes",
      "Short-term relief: restart the offending service; enable zram (zramctl) on low-RAM nodes",
      "Long-term: cap the service with systemd MemoryMax= and add a swap/zram budget",
    ],
  },
  {
    id: "FAN_STALL",
    severity: "CRIT",
    title: "Fan stalled under thermal load",
    applies: (p) => p.hasFan,
    test: (s) => s.fanRpm !== null && s.fanRpm < 200 && s.tempC > 60,
    detail: (s) => `Fan reads ${s.fanRpm ?? 0} RPM with SoC at ${fx(s.tempC, 1)}°C.`,
    steps: () => [
      "Check the fan header is seated and the connector is on the correct pins",
      "Command full duty and listen: echo 255 | sudo tee /sys/class/hwmon/hwmon*/pwm1",
      "Inspect for obstruction; replace the fan if it does not spin at 100% duty",
      "Until resolved, cap the workload — treat the node as passively cooled",
    ],
  },
  {
    id: "CLOCK_CAP",
    severity: "WARN",
    title: "Clock capped under load",
    applies: () => true,
    test: (s, p) => s.cpuLoadPct > 70 && s.clockMhz < p.maxClockMhz * 0.65 && !s.throttled,
    detail: (s, p) => `${s.clockMhz} MHz at ${s.cpuLoadPct}% load (${p.maxClockMhz} MHz capable). Governor or power cap is limiting.`,
    steps: (p) =>
      p.id === "orin-nano"
        ? [
            "Check active power mode: sudo nvpmodel -q",
            "Pin max clocks if power budget allows: sudo jetson_clocks",
          ]
        : [
            "Check governor: cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor",
            "Set performance governor if the power budget allows: echo performance | sudo tee .../scaling_governor",
          ],
  },
  {
    id: "LINK_SILENT",
    severity: "WARN",
    title: "Expected data link silent",
    applies: () => true,
    test: (s) => s.links.some((l) => !l.active || l.kbps === 0),
    detail: (s) => {
      const dead = s.links.filter((l) => !l.active || l.kbps === 0).map((l) => l.proto);
      return `No traffic on: ${dead.join(", ")}.`;
    },
    steps: () => [
      "Confirm the producing service is up: systemctl status <service>",
      "MQTT: mosquitto_sub -h <broker> -t '#' -C 1 -W 5 to prove the broker path",
      "CoT/TAK: verify the TAK server port is reachable: nc -vz <tak-host> 8089",
      "RTSP/MAVLink: check the sensor process and serial/UDP endpoint it publishes on",
    ],
  },
]);

/**
 * @param {Sample|null} s @param {DeviceProfile} p @param {boolean} linkUp
 * @returns {Fault[]}
 */
function evaluateFaults(s, p, linkUp) {
  if (!linkUp) {
    return [
      {
        id: "AGENT_DOWN",
        severity: "CRIT",
        title: "Telemetry agent unreachable",
        detail: "No response from the device agent within the poll timeout.",
        steps: [
          "Ping the node: ping -c 3 <host>",
          "Check the agent: systemctl status edge-agent  /  journalctl -u edge-agent -n 50",
          "Verify the port is open from this console's host: nc -vz <host> <port>",
          "On an air-gapped VLAN, confirm the switch port and any host firewall (nftables/iptables) allow the agent port",
        ],
      },
    ];
  }
  if (s === null) {
    return [];
  }
  const out = [];
  for (const rule of RULES) {
    if (!rule.applies(p)) {
      continue;
    }
    if (!rule.test(s, p)) {
      continue;
    }
    out.push({
      id: rule.id,
      severity: rule.severity,
      title: rule.title,
      detail: rule.detail(s, p),
      steps: rule.steps(p),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Presentational subcomponents                                        */
/* ------------------------------------------------------------------ */

/** Tracked-out micro label, rack-faceplate style. */
function Micro({ children, color }) {
  return (
    <span
      style={{
        fontFamily: T.sans,
        fontSize: 10,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: color ?? T.dim,
      }}
    >
      {children}
    </span>
  );
}

/** Status LED. */
function Led({ color, pulse }) {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        boxShadow: `0 0 6px ${color}`,
        display: "inline-block",
        animation: pulse ? "etcPulse 1.6s ease-in-out infinite" : "none",
      }}
    />
  );
}

/**
 * Signature element: bench-PSU style power rail.
 * Tick-ruled horizontal rail, filled envelope, needle at current draw.
 */
function RailGauge({ label, unit, value, max, warnAt, critAt }) {
  const pct = clamp((value / max) * 100, 0, 100);
  const level = value >= critAt ? T.crit : value >= warnAt ? T.warn : T.data;
  const ticks = useMemo(() => Array.from({ length: 21 }, (_, i) => i), []);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <Micro>{label}</Micro>
        <span style={{ fontFamily: T.mono, fontSize: 15, color: level }}>
          {fx(value, 1)}
          <span style={{ fontSize: 10, color: T.dim, marginLeft: 3 }}>{unit}</span>
        </span>
      </div>
      <div style={{ position: "relative", height: 18, background: T.panelDeep, border: `1px solid ${T.edgeSoft}`, borderRadius: 2 }}>
        <div
          style={{
            position: "absolute",
            insetBlock: 2,
            left: 2,
            width: `calc(${pct}% - 2px)`,
            background: `linear-gradient(90deg, ${level}22, ${level}55)`,
            borderRadius: 1,
            transition: "width 400ms linear",
          }}
        />
        <div style={{ position: "absolute", inset: 0, display: "flex", justifyContent: "space-between", padding: "0 2px" }}>
          {ticks.map((i) => (
            <span
              key={i}
              style={{
                width: 1,
                height: i % 5 === 0 ? "100%" : "40%",
                alignSelf: "flex-end",
                background: i % 5 === 0 ? T.faint : T.edgeSoft,
              }}
            />
          ))}
        </div>
        <div
          style={{
            position: "absolute",
            top: -2,
            bottom: -2,
            left: `${pct}%`,
            width: 2,
            background: level,
            boxShadow: `0 0 5px ${level}`,
            transition: "left 400ms linear",
          }}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontFamily: T.mono, fontSize: 9, color: T.faint }}>0</span>
        <span style={{ fontFamily: T.mono, fontSize: 9, color: T.faint }}>{max}{unit}</span>
      </div>
    </div>
  );
}

/** Horizontal utilization bar. */
function UtilBar({ label, valueText, pct, color }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <Micro>{label}</Micro>
        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.ink }}>{valueText}</span>
      </div>
      <div style={{ height: 5, background: T.panelDeep, borderRadius: 2, overflow: "hidden", border: `1px solid ${T.edgeSoft}` }}>
        <div
          style={{
            height: "100%",
            width: `${clamp(pct, 0, 100)}%`,
            background: color,
            transition: "width 400ms linear",
          }}
        />
      </div>
    </div>
  );
}

/** Dual sparkline: power (cyan) and temperature (amber). */
function Spark({ history, maxPowerW, throttleTempC }) {
  const W = 260;
  const H = 44;
  const path = useCallback(
    (get, maxV) => {
      if (history.length < 2) {
        return "";
      }
      const step = W / (HISTORY_LEN - 1);
      const offset = HISTORY_LEN - history.length;
      return history
        .map((s, i) => {
          const x = (offset + i) * step;
          const y = H - clamp(get(s) / maxV, 0, 1) * (H - 4) - 2;
          return `${i === 0 ? "M" : "L"}${fx(x, 1)},${fx(y, 1)}`;
        })
        .join(" ");
    },
    [history]
  );
  const throttleY = H - clamp(throttleTempC / (throttleTempC + 15), 0, 1) * (H - 4) - 2;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <Micro>Trend · {HISTORY_LEN}s</Micro>
        <span style={{ display: "flex", gap: 10 }}>
          <Micro color={T.data}>PWR</Micro>
          <Micro color={T.warn}>TEMP</Micro>
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: H, background: T.panelDeep, border: `1px solid ${T.edgeSoft}`, borderRadius: 2 }}
        preserveAspectRatio="none"
        role="img"
        aria-label="Power and temperature trend"
      >
        <line x1="0" x2={W} y1={throttleY} y2={throttleY} stroke={T.crit} strokeOpacity="0.35" strokeDasharray="3 4" strokeWidth="1" />
        <path d={path((s) => s.tempC, throttleTempC + 15)} fill="none" stroke={T.warn} strokeWidth="1.2" strokeOpacity="0.9" />
        <path d={path((s) => s.powerW, maxPowerW)} fill="none" stroke={T.data} strokeWidth="1.4" />
      </svg>
    </div>
  );
}

/** Data-on-the-wire chips. */
function LinkChips({ links, expected }) {
  const shown = links.length > 0 ? links : expected.map((proto) => ({ proto, kbps: 0, active: false }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Micro>Data on the wire</Micro>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {shown.map((l) => (
          <span
            key={l.proto}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 8px",
              border: `1px solid ${l.active ? T.edge : T.crit + "66"}`,
              borderRadius: 3,
              background: T.panelDeep,
            }}
          >
            <Led color={l.active ? T.ok : T.crit} pulse={l.active} />
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.ink }}>{l.proto}</span>
            <span style={{ fontFamily: T.mono, fontSize: 10, color: l.active ? T.dim : T.crit }}>
              {l.active ? `${l.kbps} kb/s` : "SILENT"}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Device card                                                         */
/* ------------------------------------------------------------------ */

function DeviceHeader({ profile, cfg, linkUp, worst }) {
  const ledColor = !linkUp && cfg.mode === "LIVE" ? T.crit : worst === "CRIT" ? T.crit : worst === "WARN" ? T.warn : T.ok;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 14px",
        borderBottom: `1px solid ${T.edge}`,
        background: `linear-gradient(180deg, ${T.panel}, ${T.panelDeep})`,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontFamily: T.mono, fontSize: 14, letterSpacing: "0.08em", color: T.ink }}>
          {profile.designator}
        </span>
        <Micro>{profile.label}</Micro>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontFamily: T.mono, fontSize: 10, color: T.dim }}>
          {cfg.mode === "LIVE" ? `${cfg.host}:${cfg.port}` : "SIMULATED"}
        </span>
        <Led color={ledColor} pulse={linkUp || cfg.mode === "SIM"} />
      </div>
    </div>
  );
}

function DeviceBody({ profile, sample }) {
  if (sample === null) {
    return (
      <div style={{ padding: "28px 14px", textAlign: "center" }}>
        <Micro color={T.crit}>No telemetry — see fault board below</Micro>
      </div>
    );
  }
  const memPct = (100 * sample.memUsedMb) / sample.memTotalMb;
  const clockPct = (100 * sample.clockMhz) / profile.maxClockMhz;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 14 }}>
      <RailGauge
        label="Power draw"
        unit="W"
        value={sample.powerW}
        max={profile.maxPowerW}
        warnAt={profile.maxPowerW * 0.75}
        critAt={profile.maxPowerW * 0.92}
      />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
        <UtilBar
          label="Temp"
          valueText={`${fx(sample.tempC, 1)}°C`}
          pct={(100 * sample.tempC) / (profile.throttleTempC + 10)}
          color={sample.tempC >= profile.throttleTempC ? T.crit : sample.tempC >= profile.warnTempC ? T.warn : T.ok}
        />
        <UtilBar
          label="Fan"
          valueText={profile.hasFan ? `${sample.fanRpm ?? 0} RPM` : "PASSIVE"}
          pct={profile.hasFan ? sample.fanPct ?? 0 : 0}
          color={profile.hasFan && (sample.fanRpm ?? 0) < 200 && sample.tempC > 60 ? T.crit : T.data}
        />
        <UtilBar
          label="Memory"
          valueText={`${sample.memUsedMb}/${sample.memTotalMb} MiB`}
          pct={memPct}
          color={memPct >= 90 ? T.crit : memPct >= 75 ? T.warn : T.data}
        />
        <UtilBar
          label={`Clock · ${sample.cpuLoadPct}% load`}
          valueText={`${sample.clockMhz} MHz`}
          pct={clockPct}
          color={sample.throttled ? T.crit : T.data}
        />
      </div>
      {(sample.throttled || sample.undervolt) && (
        <div style={{ display: "flex", gap: 8 }}>
          {sample.throttled && (
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.crit, border: `1px solid ${T.crit}66`, padding: "2px 6px", borderRadius: 2 }}>
              THROTTLED
            </span>
          )}
          {sample.undervolt && (
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.crit, border: `1px solid ${T.crit}66`, padding: "2px 6px", borderRadius: 2 }}>
              UNDERVOLT
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function DeviceCard({ profile, cfg, sample, history, faults, linkUp }) {
  const worst = faults.some((f) => f.severity === "CRIT") ? "CRIT" : faults.some((f) => f.severity === "WARN") ? "WARN" : "OK";
  return (
    <section
      style={{
        background: T.panel,
        border: `1px solid ${worst === "CRIT" ? T.crit + "55" : T.edge}`,
        borderRadius: 4,
        overflow: "hidden",
        boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
      }}
    >
      <DeviceHeader profile={profile} cfg={cfg} linkUp={linkUp} worst={worst} />
      <DeviceBody profile={profile} sample={sample} />
      {sample !== null && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "0 14px 14px" }}>
          <Spark history={history} maxPowerW={profile.maxPowerW} throttleTempC={profile.throttleTempC} />
          <LinkChips links={sample.links} expected={profile.expectedLinks} />
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Fault board (instant troubleshooting)                               */
/* ------------------------------------------------------------------ */

function FaultRow({ deviceLabel, fault, expanded, onToggle }) {
  const color = SEVERITY_COLOR[fault.severity] ?? T.data;
  return (
    <div style={{ borderBottom: `1px solid ${T.edgeSoft}` }}>
      <button
        onClick={onToggle}
        style={{
          display: "flex",
          width: "100%",
          alignItems: "center",
          gap: 12,
          padding: "10px 14px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ fontFamily: T.mono, fontSize: 10, color, border: `1px solid ${color}66`, padding: "2px 6px", borderRadius: 2, flexShrink: 0 }}>
          {fault.severity}
        </span>
        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.dim, flexShrink: 0 }}>{deviceLabel}</span>
        <span style={{ fontFamily: T.sans, fontSize: 13, color: T.ink, flex: 1 }}>{fault.title}</span>
        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.dim }}>{expanded ? "−" : "+"}</span>
      </button>
      {expanded && (
        <div style={{ padding: "0 14px 12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ margin: 0, fontFamily: T.sans, fontSize: 12.5, color: T.dim, lineHeight: 1.5 }}>{fault.detail}</p>
          <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 5 }}>
            {fault.steps.map((step, i) => (
              <li key={i} style={{ fontFamily: T.mono, fontSize: 11.5, color: T.ink, lineHeight: 1.55 }}>
                {step}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function FaultBoard({ entries }) {
  const [openKey, setOpenKey] = useState(null);
  if (entries.length === 0) {
    return (
      <section style={{ background: T.panel, border: `1px solid ${T.edge}`, borderRadius: 4, padding: "14px 16px", display: "flex", alignItems: "center", gap: 10 }}>
        <Led color={T.ok} pulse />
        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.ok, letterSpacing: "0.08em" }}>ALL SYSTEMS NOMINAL</span>
        <span style={{ fontFamily: T.sans, fontSize: 12, color: T.dim }}>No active faults across the fleet.</span>
      </section>
    );
  }
  return (
    <section style={{ background: T.panel, border: `1px solid ${T.edge}`, borderRadius: 4, overflow: "hidden" }}>
      <div style={{ padding: "10px 14px", borderBottom: `1px solid ${T.edge}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Micro color={T.ink}>Fault board · tap a fault for its runbook</Micro>
        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.warn }}>{entries.length} active</span>
      </div>
      {entries.map((e) => (
        <FaultRow
          key={e.key}
          deviceLabel={e.deviceLabel}
          fault={e.fault}
          expanded={openKey === e.key}
          onToggle={() => setOpenKey((k) => (k === e.key ? null : e.key))}
        />
      ))}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Connection config drawer                                            */
/* ------------------------------------------------------------------ */

function ConfigRow({ cfg, profile, onChange }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: `1px solid ${T.edgeSoft}` }}>
      <span style={{ fontFamily: T.mono, fontSize: 12, color: T.ink, width: 90, flexShrink: 0 }}>{profile.designator}</span>
      <button
        onClick={() => onChange({ ...cfg, mode: cfg.mode === "SIM" ? "LIVE" : "SIM" })}
        style={{
          fontFamily: T.mono,
          fontSize: 11,
          color: cfg.mode === "LIVE" ? T.ok : T.data,
          background: T.panelDeep,
          border: `1px solid ${T.edge}`,
          borderRadius: 3,
          padding: "4px 10px",
          cursor: "pointer",
        }}
      >
        {cfg.mode}
      </button>
      <input
        value={cfg.host}
        onChange={(e) => onChange({ ...cfg, host: e.target.value })}
        placeholder="host / IP"
        disabled={cfg.mode === "SIM"}
        style={{
          fontFamily: T.mono,
          fontSize: 12,
          color: T.ink,
          background: T.panelDeep,
          border: `1px solid ${T.edge}`,
          borderRadius: 3,
          padding: "5px 8px",
          width: 140,
          opacity: cfg.mode === "SIM" ? 0.4 : 1,
        }}
      />
      <input
        value={String(cfg.port)}
        onChange={(e) => {
          const parsed = Number.parseInt(e.target.value, 10);
          onChange({ ...cfg, port: Number.isFinite(parsed) ? parsed : cfg.port });
        }}
        placeholder="port"
        disabled={cfg.mode === "SIM"}
        inputMode="numeric"
        style={{
          fontFamily: T.mono,
          fontSize: 12,
          color: T.ink,
          background: T.panelDeep,
          border: `1px solid ${T.edge}`,
          borderRadius: 3,
          padding: "5px 8px",
          width: 70,
          opacity: cfg.mode === "SIM" ? 0.4 : 1,
        }}
      />
    </div>
  );
}

function ConfigDrawer({ configs, onChange }) {
  return (
    <section style={{ background: T.panel, border: `1px solid ${T.edge}`, borderRadius: 4, padding: "10px 14px 4px" }}>
      <Micro color={T.ink}>Connections · LIVE polls GET /telemetry on each agent</Micro>
      <div style={{ marginTop: 4 }}>
        {configs.map((cfg) => (
          <ConfigRow
            key={cfg.key}
            cfg={cfg}
            profile={profileById(cfg.profileId)}
            onChange={(next) => onChange(next)}
          />
        ))}
      </div>
      <p style={{ fontFamily: T.sans, fontSize: 11, color: T.dim, lineHeight: 1.5, margin: "8px 0" }}>
        Air-gap note: this console makes no calls outside the hosts listed above. Agents are Python-stdlib only
        (no pip). Serve this app as a static bundle from any LAN host.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Root component                                                      */
/* ------------------------------------------------------------------ */

/** @returns {DeviceConfig[]} */
function makeDefaultConfigs() {
  return PROFILES.map((p, i) => ({
    key: p.id,
    profileId: p.id,
    mode: "SIM",
    host: `192.168.10.${11 + i}`,
    port: 8090,
  }));
}

export default function EdgeTelemetryConsole() {
  const [configs, setConfigs] = useState(makeDefaultConfigs);
  const [showConfig, setShowConfig] = useState(false);
  const [frames, setFrames] = useState(() => new Map());
  const simStates = useRef(new Map());
  const histories = useRef(new Map());
  const configsRef = useRef(configs);
  configsRef.current = configs;

  const pollOne = useCallback(async (cfg) => {
    const profile = profileById(cfg.profileId);
    if (cfg.mode === "SIM") {
      let sim = simStates.current.get(cfg.key);
      if (sim === undefined) {
        sim = makeSimState(profile);
        simStates.current.set(cfg.key, sim);
      }
      return { sample: stepSim(sim, profile), linkUp: true };
    }
    try {
      const sample = await fetchLiveSample(cfg, profile);
      return { sample, linkUp: true };
    } catch (error) {
      console.error(`Poll failed for ${cfg.key}:`, error);
      return { sample: null, linkUp: false };
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      const current = configsRef.current;
      const results = await Promise.all(current.map((cfg) => pollOne(cfg)));
      if (cancelled) {
        return;
      }
      const next = new Map();
      current.forEach((cfg, i) => {
        const result = results[i] ?? { sample: null, linkUp: false };
        if (result.sample !== null) {
          const hist = histories.current.get(cfg.key) ?? [];
          const appended = [...hist, result.sample].slice(-HISTORY_LEN);
          histories.current.set(cfg.key, appended);
        }
        next.set(cfg.key, result);
      });
      setFrames(next);
    };

    const timer = setInterval(() => {
      tick().catch((error) => console.error("Tick failed:", error));
    }, TICK_MS);
    tick().catch((error) => console.error("Initial tick failed:", error));

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollOne]);

  const faultEntries = useMemo(() => {
    const entries = [];
    for (const cfg of configs) {
      const profile = profileById(cfg.profileId);
      const frame = frames.get(cfg.key) ?? { sample: null, linkUp: cfg.mode === "SIM" };
      const faults = evaluateFaults(frame.sample, profile, frame.linkUp || cfg.mode === "SIM");
      for (const fault of faults) {
        entries.push({ key: `${cfg.key}:${fault.id}`, deviceLabel: profile.designator, fault });
      }
    }
    const order = { CRIT: 0, WARN: 1, INFO: 2 };
    return entries.sort((a, b) => (order[a.fault.severity] ?? 3) - (order[b.fault.severity] ?? 3));
  }, [configs, frames]);

  const critCount = faultEntries.filter((e) => e.fault.severity === "CRIT").length;
  const warnCount = faultEntries.filter((e) => e.fault.severity === "WARN").length;
  const liveCount = configs.filter((c) => c.mode === "LIVE").length;

  return (
    <div style={{ minHeight: "100vh", background: T.bg, padding: "16px clamp(12px, 3vw, 28px) 40px", color: T.ink }}>
      <style>{`
        @keyframes etcPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
        button:focus-visible, input:focus-visible { outline: 2px solid ${T.data}; outline-offset: 1px; }
        input::placeholder { color: ${T.faint}; }
      `}</style>

      <header style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "0 2px 14px" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontFamily: T.mono, fontSize: 16, letterSpacing: "0.22em", color: T.ink }}>
            EDGE TELEMETRY
          </span>
          <Micro>Air-gapped fleet console · {PROFILES.length} nodes</Micro>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Led color={critCount > 0 ? T.crit : T.faint} />
            <span style={{ fontFamily: T.mono, fontSize: 12, color: critCount > 0 ? T.crit : T.dim }}>{critCount} CRIT</span>
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Led color={warnCount > 0 ? T.warn : T.faint} />
            <span style={{ fontFamily: T.mono, fontSize: 12, color: warnCount > 0 ? T.warn : T.dim }}>{warnCount} WARN</span>
          </span>
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.dim }}>
            {liveCount > 0 ? `${liveCount} LIVE / ${configs.length - liveCount} SIM` : "ALL SIM"}
          </span>
          <button
            onClick={() => setShowConfig((v) => !v)}
            style={{
              fontFamily: T.mono,
              fontSize: 11,
              letterSpacing: "0.1em",
              color: showConfig ? T.bg : T.ink,
              background: showConfig ? T.data : T.panelDeep,
              border: `1px solid ${T.edge}`,
              borderRadius: 3,
              padding: "6px 12px",
              cursor: "pointer",
            }}
          >
            CONNECT
          </button>
        </div>
      </header>

      <main style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {showConfig && (
          <ConfigDrawer
            configs={configs}
            onChange={(next) =>
              setConfigs((prev) => prev.map((c) => (c.key === next.key ? next : c)))
            }
          />
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 }}>
          {configs.map((cfg) => {
            const profile = profileById(cfg.profileId);
            const frame = frames.get(cfg.key) ?? { sample: null, linkUp: cfg.mode === "SIM" };
            const history = histories.current.get(cfg.key) ?? [];
            const faults = evaluateFaults(frame.sample, profile, frame.linkUp || cfg.mode === "SIM");
            return (
              <DeviceCard
                key={cfg.key}
                profile={profile}
                cfg={cfg}
                sample={frame.sample}
                history={history}
                faults={faults}
                linkUp={frame.linkUp}
              />
            );
          })}
        </div>

        <FaultBoard entries={faultEntries} />
      </main>
    </div>
  );
}
