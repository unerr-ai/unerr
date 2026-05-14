/**
 * System health probes — power & load awareness for warm-start scheduling.
 *
 * Cross-platform:
 *   macOS:   `pmset -g batt` for battery, os.loadavg() for load
 *   Linux:   /sys/class/power_supply/ for battery, os.loadavg() for load
 *   Windows: wmic for battery, CPU idle delta sampling for load
 *
 * Results are cached for 10 seconds to avoid repeated system calls.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { cpus, loadavg, platform } from "node:os";

const CACHE_TTL_MS = 10_000;

// ── Battery detection ─────────────────────────────────────────

interface CachedValue<T> {
  value: T;
  ts: number;
}

let batteryCache: CachedValue<boolean> | null = null;
let loadCache: CachedValue<number> | null = null;

export function onBattery(): boolean {
  const now = Date.now();
  if (batteryCache && now - batteryCache.ts < CACHE_TTL_MS) {
    return batteryCache.value;
  }
  const result = detectBattery();
  batteryCache = { value: result, ts: now };
  return result;
}

function detectBattery(): boolean {
  const plat = platform();

  if (plat === "darwin") return detectBatteryMacOS();
  if (plat === "linux") return detectBatteryLinux();
  if (plat === "win32") return detectBatteryWindows();

  return false; // Unknown platform — assume plugged in
}

function detectBatteryMacOS(): boolean {
  try {
    const out = execSync("pmset -g batt", {
      encoding: "utf-8",
      timeout: 3000,
    });
    // "Now drawing from 'Battery Power'" means on battery
    // "Now drawing from 'AC Power'" means plugged in
    // No battery line at all means desktop Mac
    if (out.includes("'Battery Power'")) return true;
    return false;
  } catch {
    return false;
  }
}

function detectBatteryLinux(): boolean {
  try {
    const psDir = "/sys/class/power_supply";
    if (!existsSync(psDir)) return false;

    const supplies = readdirSync(psDir);
    for (const name of supplies) {
      // AC adapters are named AC*, ADP*, etc.
      if (name.startsWith("AC") || name.startsWith("ADP")) {
        const onlinePath = `${psDir}/${name}/online`;
        if (existsSync(onlinePath)) {
          const online = readFileSync(onlinePath, "utf-8").trim();
          if (online === "0") return true; // AC disconnected
          if (online === "1") return false; // AC connected
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

function detectBatteryWindows(): boolean {
  try {
    const out = execSync("wmic path Win32_Battery get BatteryStatus /value", {
      encoding: "utf-8",
      timeout: 5000,
    });
    // BatteryStatus=1 means discharging (on battery)
    // BatteryStatus=2 means AC connected
    const match = out.match(/BatteryStatus=(\d+)/);
    if (match) return match[1] === "1";
    return false;
  } catch {
    return false;
  }
}

// ── Load average ──────────────────────────────────────────────

export function loadAverage1(): number {
  const now = Date.now();
  if (loadCache && now - loadCache.ts < CACHE_TTL_MS) {
    return loadCache.value;
  }
  const result = detectLoad();
  loadCache = { value: result, ts: now };
  return result;
}

function detectLoad(): number {
  if (platform() === "win32") return windowsLoadEstimate();
  return loadavg()[0] ?? 0;
}

/**
 * Estimate 1-minute load average on Windows using a 1s CPU idle delta.
 * This is a rough approximation — Windows doesn't expose loadavg natively.
 */
function windowsLoadEstimate(): number {
  const cores = cpus();
  const total = cores.length;
  if (total === 0) return 0;

  let totalIdle = 0;
  let totalTick = 0;
  for (const cpu of cores) {
    const { user, nice, sys, idle, irq } = cpu.times;
    totalTick += user + nice + sys + idle + irq;
    totalIdle += idle;
  }

  // Rough estimate: (busy fraction) * core count ≈ load
  const busy = 1 - totalIdle / totalTick;
  return Math.max(0, busy * total);
}

/** Reset caches (for testing). */
export function resetHealthCaches(): void {
  batteryCache = null;
  loadCache = null;
}
