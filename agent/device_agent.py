#!/usr/bin/env python3
"""Edge telemetry agent for Raspberry Pi 5, Jetson Orin Nano, and Pi Zero 2 W.

Standard library only: safe to deploy on air-gapped networks with no pip
access. Serves GET /telemetry as JSON for the Edge Telemetry Console.

Run:  python3 device_agent.py --port 8090 --links MQTT CoT/TAK JSON/REST
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Final

logger: logging.Logger = logging.getLogger("edge-agent")

MODEL_PATH: Final[Path] = Path("/proc/device-tree/model")
MEMINFO_PATH: Final[Path] = Path("/proc/meminfo")
STAT_PATH: Final[Path] = Path("/proc/stat")
NETDEV_PATH: Final[Path] = Path("/proc/net/dev")
THERMAL_GLOB: Final[str] = "/sys/class/thermal/thermal_zone*/temp"
CPUFREQ_PATH: Final[Path] = Path(
    "/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq"
)
HWMON_ROOT: Final[Path] = Path("/sys/class/hwmon")
VCGENCMD_TIMEOUT_S: Final[float] = 1.0
UNDERVOLT_BIT: Final[int] = 0x1
THROTTLED_BIT: Final[int] = 0x4


class TelemetryError(Exception):
    """Raised when a required telemetry source cannot be read."""


@dataclass(frozen=True)
class MemInfo:
    used_mb: int
    total_mb: int


@dataclass(frozen=True)
class ThrottleFlags:
    throttled: bool
    undervolt: bool


def read_first_line(path: Path) -> str:
    """Read and strip the first line of a sysfs/procfs file."""
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        return fh.readline().strip().rstrip("\x00")


def detect_device_id() -> str:
    """Map /proc/device-tree/model to a console profile id."""
    try:
        model: str = read_first_line(MODEL_PATH).lower()
    except OSError as exc:
        logger.warning("Could not read device model: %s", exc)
        return "unknown"
    if "raspberry pi 5" in model:
        return "pi5"
    if "raspberry pi zero 2" in model:
        return "pi-zero-2w"
    if "orin nano" in model or "nvidia" in model:
        return "orin-nano"
    return "unknown"


def read_temp_c() -> float | None:
    """Read the hottest thermal zone in Celsius."""
    readings: list[float] = []
    for zone in sorted(Path("/").glob(THERMAL_GLOB.lstrip("/"))):
        try:
            readings.append(int(read_first_line(zone)) / 1000.0)
        except (OSError, ValueError) as exc:
            logger.debug("Skipping thermal zone %s: %s", zone, exc)
    if not readings:
        return None
    return max(readings)


def read_meminfo() -> MemInfo | None:
    """Parse MemTotal and MemAvailable into used/total MiB."""
    try:
        text: str = MEMINFO_PATH.read_text(encoding="utf-8")
    except OSError as exc:
        logger.debug("meminfo unreadable: %s", exc)
        return None
    fields: dict[str, int] = {}
    for line in text.splitlines():
        parts: list[str] = line.split()
        if len(parts) >= 2 and parts[0].rstrip(":") in ("MemTotal", "MemAvailable"):
            try:
                fields[parts[0].rstrip(":")] = int(parts[1])
            except ValueError:
                continue
    total_kb: int = fields.get("MemTotal", 0)
    avail_kb: int = fields.get("MemAvailable", 0)
    if total_kb <= 0:
        return None
    return MemInfo(used_mb=(total_kb - avail_kb) // 1024, total_mb=total_kb // 1024)


def read_clock_mhz() -> int | None:
    """Current CPU0 clock in MHz from cpufreq."""
    try:
        return int(read_first_line(CPUFREQ_PATH)) // 1000
    except (OSError, ValueError) as exc:
        logger.debug("cpufreq unreadable: %s", exc)
        return None


def read_cpu_counters() -> tuple[int, int] | None:
    """Return (idle, total) jiffies from the aggregate cpu line."""
    try:
        line: str = read_first_line(STAT_PATH)
    except OSError as exc:
        logger.debug("/proc/stat unreadable: %s", exc)
        return None
    parts: list[str] = line.split()
    if len(parts) < 8 or parts[0] != "cpu":
        return None
    try:
        values: list[int] = [int(v) for v in parts[1:9]]
    except ValueError:
        return None
    idle: int = values[3] + values[4]
    return idle, sum(values)


def scan_hwmon_power_w() -> float | None:
    """Sum hwmon power*_input sensors (microwatts). Works on Jetson INA3221."""
    total_uw: int = 0
    found: bool = False
    if not HWMON_ROOT.is_dir():
        return None
    for sensor in sorted(HWMON_ROOT.glob("hwmon*/power*_input")):
        try:
            total_uw += int(read_first_line(sensor))
            found = True
        except (OSError, ValueError) as exc:
            logger.debug("Skipping hwmon sensor %s: %s", sensor, exc)
    if not found:
        return None
    return total_uw / 1_000_000.0


def run_vcgencmd(args: list[str]) -> str | None:
    """Run vcgencmd (Raspberry Pi firmware tool) and return stdout."""
    try:
        result = subprocess.run(
            ["vcgencmd", *args],
            capture_output=True,
            text=True,
            timeout=VCGENCMD_TIMEOUT_S,
            check=True,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("vcgencmd %s failed: %s", args, exc)
        return None
    return result.stdout


def parse_pmic_power_w(output: str) -> float | None:
    """Sum rail power from `vcgencmd pmic_read_adc` (Pi 5 only).

    Output pairs rails as NAME_A current(n)=x.xA and NAME_V volt(n)=y.yV.
    """
    amps: dict[str, float] = {}
    volts: dict[str, float] = {}
    for line in output.splitlines():
        line = line.strip()
        if "=" not in line or " " not in line:
            continue
        name: str = line.split(" ", 1)[0]
        try:
            value: float = float(line.split("=", 1)[1].rstrip("AV"))
        except ValueError:
            continue
        if name.endswith("_A"):
            amps[name[:-2]] = value
        elif name.endswith("_V"):
            volts[name[:-2]] = value
    shared: set[str] = set(amps) & set(volts)
    if not shared:
        return None
    return sum(amps[rail] * volts[rail] for rail in shared)


def read_pi_power_w() -> float | None:
    """Board power on Pi 5 via the PMIC ADC. Unavailable on older Pis."""
    output: str | None = run_vcgencmd(["pmic_read_adc"])
    if output is None:
        return None
    return parse_pmic_power_w(output)


def read_throttle_flags() -> ThrottleFlags:
    """Decode `vcgencmd get_throttled` bits. Non-Pi platforms report clean."""
    output: str | None = run_vcgencmd(["get_throttled"])
    if output is None or "=" not in output:
        return ThrottleFlags(throttled=False, undervolt=False)
    try:
        raw: int = int(output.split("=", 1)[1].strip(), 16)
    except ValueError:
        return ThrottleFlags(throttled=False, undervolt=False)
    return ThrottleFlags(
        throttled=bool(raw & THROTTLED_BIT),
        undervolt=bool(raw & UNDERVOLT_BIT),
    )


def read_fan() -> tuple[int | None, int | None]:
    """Return (fan_pct, fan_rpm) from hwmon, or (None, None) if fanless."""
    pct: int | None = None
    rpm: int | None = None
    if not HWMON_ROOT.is_dir():
        return None, None
    for pwm in sorted(HWMON_ROOT.glob("hwmon*/pwm1")):
        try:
            pct = round(int(read_first_line(pwm)) * 100 / 255)
            break
        except (OSError, ValueError) as exc:
            logger.debug("Skipping pwm %s: %s", pwm, exc)
    for tach in sorted(HWMON_ROOT.glob("hwmon*/fan1_input")):
        try:
            rpm = int(read_first_line(tach))
            break
        except (OSError, ValueError) as exc:
            logger.debug("Skipping tach %s: %s", tach, exc)
    return pct, rpm


def read_net_bytes() -> int:
    """Total RX+TX bytes across non-loopback interfaces."""
    try:
        text: str = NETDEV_PATH.read_text(encoding="utf-8")
    except OSError as exc:
        logger.debug("net/dev unreadable: %s", exc)
        return 0
    total: int = 0
    for line in text.splitlines()[2:]:
        if ":" not in line:
            continue
        name, rest = line.split(":", 1)
        if name.strip() == "lo":
            continue
        cols: list[str] = rest.split()
        if len(cols) >= 9:
            try:
                total += int(cols[0]) + int(cols[8])
            except ValueError:
                continue
    return total


class TelemetryCollector:
    """Stateful collector: tracks CPU and network deltas between polls."""

    def __init__(self, device_id: str, link_names: list[str]) -> None:
        self._device_id: str = device_id
        self._link_names: list[str] = list(link_names)
        self._prev_cpu: tuple[int, int] | None = read_cpu_counters()
        self._prev_net: tuple[float, int] = (time.monotonic(), read_net_bytes())

    def _cpu_load_pct(self) -> float | None:
        current: tuple[int, int] | None = read_cpu_counters()
        if current is None or self._prev_cpu is None:
            self._prev_cpu = current
            return None
        d_idle: int = current[0] - self._prev_cpu[0]
        d_total: int = current[1] - self._prev_cpu[1]
        self._prev_cpu = current
        if d_total <= 0:
            return None
        return round(100.0 * (1.0 - d_idle / d_total), 1)

    def _net_kbps(self) -> float:
        now: float = time.monotonic()
        total: int = read_net_bytes()
        elapsed: float = max(now - self._prev_net[0], 0.001)
        delta: int = max(total - self._prev_net[1], 0)
        self._prev_net = (now, total)
        return round(delta * 8 / 1000.0 / elapsed, 1)

    def _power_w(self) -> float | None:
        if self._device_id == "orin-nano":
            return scan_hwmon_power_w()
        return read_pi_power_w()

    def collect(self) -> dict[str, object]:
        """Assemble one telemetry sample as a JSON-ready dict."""
        mem: MemInfo | None = read_meminfo()
        flags: ThrottleFlags = read_throttle_flags()
        fan_pct, fan_rpm = read_fan()
        kbps: float = self._net_kbps()
        per_link: float = round(kbps / max(len(self._link_names), 1), 1)
        return {
            "device": self._device_id,
            "ts": int(time.time() * 1000),
            "power_w": self._power_w(),
            "mem_used_mb": mem.used_mb if mem else None,
            "mem_total_mb": mem.total_mb if mem else None,
            "clock_mhz": read_clock_mhz(),
            "cpu_load_pct": self._cpu_load_pct(),
            "temp_c": read_temp_c(),
            "fan_pct": fan_pct,
            "fan_rpm": fan_rpm,
            "throttled": flags.throttled,
            "undervolt": flags.undervolt,
            "links": [
                {"proto": name, "kbps": per_link, "active": kbps > 0.5}
                for name in self._link_names
            ],
        }


def make_handler(collector: TelemetryCollector) -> type[BaseHTTPRequestHandler]:
    """Build a request handler bound to the collector via closure."""

    class Handler(BaseHTTPRequestHandler):
        def _send_json(self, status: int, payload: dict[str, object]) -> None:
            body: bytes = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            # LAN-scoped CORS so the console (served from another LAN host)
            # can poll this agent. Acceptable inside an isolated enclave;
            # tighten to the console host's origin if policy requires.
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 (http.server API name)
            if self.path == "/healthz":
                self._send_json(200, {"ok": True})
                return
            if self.path != "/telemetry":
                self._send_json(404, {"error": "unknown path"})
                return
            try:
                self._send_json(200, collector.collect())
            except TelemetryError as exc:
                logger.error("Collection failed: %s", exc)
                self._send_json(500, {"error": str(exc)})

        def log_message(self, fmt: str, *args: object) -> None:
            logger.debug("%s %s", self.address_string(), fmt % args)

    return Handler


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Edge telemetry agent")
    parser.add_argument("--bind", default="0.0.0.0", help="Bind address")
    parser.add_argument("--port", type=int, default=8090, help="Listen port")
    parser.add_argument(
        "--links",
        nargs="*",
        default=["MQTT"],
        help="Data link labels to report (e.g. MQTT CoT/TAK RTSP)",
    )
    parser.add_argument("--verbose", action="store_true", help="Debug logging")
    return parser.parse_args()


def main() -> int:
    args: argparse.Namespace = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    device_id: str = detect_device_id()
    collector = TelemetryCollector(device_id=device_id, link_names=args.links)
    server = ThreadingHTTPServer((args.bind, args.port), make_handler(collector))
    logger.info("Agent for %s listening on %s:%d", device_id, args.bind, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
