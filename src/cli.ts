#!/usr/bin/env node

import { Command } from "commander";
import keytar from "keytar";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const SERVICE_NAME = "droidx";
const CONFIG_DIR = join(homedir(), ".config", "droidx");
const CONFIG_PATH = join(CONFIG_DIR, "profiles.json");
const FACTORY_API_BASE = "https://api.factory.ai";
const FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Scoring tunables
// ---------------------------------------------------------------------------

/** If a profile's 5h remaining drops below this %, treat it as currently unusable. */
let MIN_5H_REMAINING_PCT = 15;

/**
 * Weights for combining weekly and monthly waste risk into a single urgency
 * score.  Weekly quota resets sooner so wasting it is more immediate;
 * monthly is still important but slightly less urgent to burn through.
 */
let WEEKLY_WASTE_WEIGHT = 0.8;
let MONTHLY_WASTE_WEIGHT = 0.2;

type Settings = {
  weeklyWeight: number;   // monthly = 1 - weeklyWeight
  min5hPct: number;
};

const DEFAULT_SETTINGS: Settings = {
  weeklyWeight: WEEKLY_WASTE_WEIGHT,
  min5hPct: MIN_5H_REMAINING_PCT,
};

type Config = {
  profiles: string[];
  settings?: Partial<Settings>;
};

/** A single rate-limit window returned by the billing API. */
type WindowInfo = {
  window: string;       // e.g. "5h", "weekly", "monthly"
  limit: number;
  remaining: number;
  reset_at: string;     // ISO-8601
};

/** Parsed limits for one profile. */
type ProfileLimits = {
  name: string;
  apiKey: string;
  windows: WindowInfo[];
  error?: string;       // set when the API call fails
};

/** Profile with a computed urgency score. */
type ScoredProfile = ProfileLimits & {
  urgency: number;
};

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function validateProfileName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    fail(
      "Profile names may contain only letters, numbers, dots, underscores, and hyphens.",
    );
  }
}

async function loadConfig(): Promise<Config> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("profiles" in parsed) ||
      !Array.isArray(parsed.profiles) ||
      !parsed.profiles.every((profile) => typeof profile === "string")
    ) {
      throw new Error("invalid configuration");
    }
    const config: Config = { profiles: parsed.profiles };
    if ("settings" in parsed && typeof parsed.settings === "object" && parsed.settings !== null) {
      config.settings = parsed.settings as Partial<Settings>;
    }
    return config;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { profiles: [] };
    }
    fail(`Cannot read ${CONFIG_PATH}.`);
  }
}

/** Apply persisted settings to the module-level scoring variables. */
function applySettings(config: Config): void {
  const s = config.settings;
  if (!s) return;
  if (typeof s.weeklyWeight === "number") {
    WEEKLY_WASTE_WEIGHT = s.weeklyWeight;
    MONTHLY_WASTE_WEIGHT = 1 - s.weeklyWeight;
  }
  if (typeof s.min5hPct === "number") {
    MIN_5H_REMAINING_PCT = s.min5hPct;
  }
}

async function saveConfig(config: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("Adding a profile requires an interactive terminal.");
  }

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    let secret = "";

    stdout.write(prompt);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const cleanup = (): void => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
    };

    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(secret);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          secret = secret.slice(0, -1);
          continue;
        }
        secret += character;
      }
    };

    stdin.on("data", onData);
  });
}

async function addProfile(name: string): Promise<void> {
  validateProfileName(name);
  const config = await loadConfig();
  const existingKey = await keytar.getPassword(SERVICE_NAME, name);

  if (existingKey !== null) {
    fail(`Profile "${name}" already exists. Remove it first or choose another name.`);
  }

  let apiKey: string;
  try {
    apiKey = (await readSecret(`Factory API key for "${name}": `)).trim();
  } catch {
    fail("Cancelled.");
  }

  if (!apiKey) {
    fail("The API key cannot be empty.");
  }

  await keytar.setPassword(SERVICE_NAME, name, apiKey);
  if (!config.profiles.includes(name)) {
    config.profiles.push(name);
    config.profiles.sort();
    await saveConfig(config);
  }

  console.log(`Saved profile "${name}" in macOS Keychain.`);
}

async function listProfiles(): Promise<void> {
  const config = await loadConfig();
  if (config.profiles.length === 0) {
    console.log("No profiles yet. Add one with: droidx add <name>");
    return;
  }

  for (const profile of config.profiles) {
    const exists = (await keytar.getPassword(SERVICE_NAME, profile)) !== null;
    console.log(`${exists ? "✓" : "!"} ${profile}`);
  }
}

async function removeProfile(name: string): Promise<void> {
  validateProfileName(name);
  const config = await loadConfig();
  const deleted = await keytar.deletePassword(SERVICE_NAME, name);

  if (!config.profiles.includes(name) && !deleted) {
    fail(`Profile "${name}" does not exist.`);
  }

  config.profiles = config.profiles.filter((profile) => profile !== name);
  await saveConfig(config);
  console.log(`Removed profile "${name}".`);
}

async function runDroid(name: string, commandArgs: string[]): Promise<void> {
  validateProfileName(name);
  const apiKey = await keytar.getPassword(SERVICE_NAME, name);
  if (apiKey === null) {
    fail(`Profile "${name}" does not exist or has no saved API key.`);
  }

  spawnDroid(apiKey, commandArgs);
}

/** Spawn the droid CLI with the given API key injected. */
function spawnDroid(apiKey: string, commandArgs: string[]): void {
  const [command = "droid", ...args] =
    commandArgs.length > 0 ? commandArgs : ["droid"];

  if (command !== "droid") {
    fail("Only the droid command can be launched through droidx.");
  }

  const child = spawn(command, args, {
    env: { ...process.env, FACTORY_API_KEY: apiKey },
    stdio: "inherit",
  });

  child.on("error", (error) => {
    fail(`Could not start droid: ${error.message}`);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 1);
    }
  });
}

// ---------------------------------------------------------------------------
// Billing / limits helpers
// ---------------------------------------------------------------------------

/**
 * New API response shape (token-rate-limits billing).
 *
 * ```json
 * {
 *   "usesTokenRateLimitsBilling": true,
 *   "limits": {
 *     "standard": {
 *       "fiveHour":  { "usedPercent": 49, "windowEnd": "...", "secondsRemaining": 12345 },
 *       "weekly":    { "usedPercent": 10, "windowEnd": "...", "secondsRemaining": 54321 },
 *       "monthly":   { "usedPercent": 5,  "windowEnd": "...", "secondsRemaining": 99999 }
 *     }
 *   }
 * }
 * ```
 */
type TokenWindowInfo = {
  usedPercent: number;
  windowEnd: string | null;
  secondsRemaining: number | null;
};

type TokenRateLimitsResponse = {
  usesTokenRateLimitsBilling: boolean;
  limits: {
    standard: Record<string, TokenWindowInfo>;
  };
};

/** Map from the new API key names to the internal window names. */
const TOKEN_WINDOW_KEY_MAP: Record<string, string> = {
  fiveHour: "5h",
  weekly: "weekly",
  monthly: "monthly",
};

/**
 * Check whether `body` matches the new token-rate-limits billing shape and,
 * if so, convert it into the existing WindowInfo[] format.
 *
 * We normalise to limit=100 / remaining=(100−usedPercent) so that percentage
 * display and urgency scoring keep working without changes.
 */
function tryParseTokenRateLimits(body: unknown): WindowInfo[] | null {
  if (
    typeof body !== "object" ||
    body === null ||
    !("usesTokenRateLimitsBilling" in body)
  ) {
    return null;
  }

  const typed = body as TokenRateLimitsResponse;
  const standard = typed.limits?.standard;
  if (typeof standard !== "object" || standard === null) return null;

  const windows: WindowInfo[] = [];
  const now = Date.now();

  for (const [apiKey, windowName] of Object.entries(TOKEN_WINDOW_KEY_MAP)) {
    const info = standard[apiKey] as TokenWindowInfo | undefined;
    if (!info || typeof info.usedPercent !== "number") continue;

    // Compute reset_at from windowEnd or secondsRemaining, falling back to now.
    let resetAt: string;
    if (info.windowEnd) {
      resetAt = info.windowEnd;
    } else if (
      typeof info.secondsRemaining === "number" &&
      info.secondsRemaining > 0
    ) {
      resetAt = new Date(now + info.secondsRemaining * 1000).toISOString();
    } else {
      // Window hasn't started yet or no data — treat as far future so it
      // doesn't inflate urgency.
      resetAt = new Date(now + windowSizeMs(windowName)).toISOString();
    }

    windows.push({
      window: windowName,
      limit: 100,
      remaining: Math.max(0, 100 - info.usedPercent),
      reset_at: resetAt,
    });
  }

  return windows.length > 0 ? windows : null;
}

/** Fetch rate-limit windows for a single API key. */
async function fetchLimits(
  name: string,
  apiKey: string,
): Promise<ProfileLimits> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(`${FACTORY_API_BASE}/api/billing/limits`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const status = res.status;
      if (status === 401) return { name, apiKey, windows: [], error: "invalid API key" };
      if (status === 429) return { name, apiKey, windows: [], error: "rate limited" };
      return { name, apiKey, windows: [], error: `HTTP ${status}` };
    }

    const body: unknown = await res.json();

    // ---------- Parse response ----------
    let windows: WindowInfo[];

    // 1) New token-rate-limits billing shape.
    const tokenWindows = tryParseTokenRateLimits(body);
    if (tokenWindows) {
      windows = tokenWindows;
    }
    // 2) Legacy: WindowInfo[] at top level.
    else if (Array.isArray(body)) {
      windows = body as WindowInfo[];
    }
    // 3) Legacy: { data: WindowInfo[] }.
    else if (
      typeof body === "object" &&
      body !== null &&
      "data" in body &&
      Array.isArray((body as Record<string, unknown>).data)
    ) {
      windows = (body as Record<string, unknown>).data as WindowInfo[];
    } else {
      return {
        name,
        apiKey,
        windows: [],
        error: `unexpected response shape: ${JSON.stringify(body).slice(0, 120)}`,
      };
    }

    return { name, apiKey, windows };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "unknown error";
    return { name, apiKey, windows: [], error: message };
  }
}

/** Map a window name to its total size in milliseconds. */
function windowSizeMs(windowName: string): number {
  const lower = windowName.toLowerCase();
  if (lower === "5h" || lower === "5_hour" || lower === "5-hour")
    return 5 * 60 * 60 * 1000;
  if (lower === "weekly" || lower === "7d")
    return 7 * 24 * 60 * 60 * 1000;
  if (lower === "monthly" || lower === "30d")
    return 30 * 24 * 60 * 60 * 1000;
  // Fallback: treat unknown windows as 24 h so they still get a score.
  return 24 * 60 * 60 * 1000;
}

/**
 * Compute an urgency score for a profile.
 *
 * Design rationale
 * ────────────────
 * • **5h window** acts as a *usability gate* — if the 5h remaining drops
 *   below {@link MIN_5H_REMAINING_PCT} the profile is effectively throttled
 *   right now, so we return −1 (unusable).  Wasting 5h quota is acceptable;
 *   it resets quickly.
 *
 * • **Weekly / Monthly windows** are the *real cost centres*.  We compute a
 *   per-window "waste risk" (how much quota will be lost if not consumed
 *   before the window resets) and combine them with configurable weights
 *   ({@link WEEKLY_WASTE_WEIGHT}, {@link MONTHLY_WASTE_WEIGHT}).
 *
 *   wasteRisk(w) = (remaining / limit) × (1 − timeLeftRatio)
 *
 *   urgency = W_weekly × weeklyWasteRisk + W_monthly × monthlyWasteRisk
 *
 * Higher urgency → more valuable quota about to be wasted → use first.
 * Returns −1 when the profile cannot be used.
 */
function scoreProfile(limits: ProfileLimits): number {
  if (limits.error || limits.windows.length === 0) return -1;

  const allExhausted = limits.windows.every((w) => w.remaining <= 0);
  if (allExhausted) return -1;

  const now = Date.now();

  // ── 5h usability gate ──────────────────────────────────────────────────
  // A near-zero 5h window means the profile is rate-limited *right now*,
  // regardless of how much weekly/monthly quota remains.
  const w5h = limits.windows.find(
    (w) => w.window.toLowerCase() === "5h" || w.window.toLowerCase() === "5_hour",
  );
  if (w5h && w5h.limit > 0) {
    const remainingPct = (w5h.remaining / w5h.limit) * 100;
    if (remainingPct < MIN_5H_REMAINING_PCT) return -1;
  }

  // ── Weekly / Monthly waste risk ────────────────────────────────────────
  let weeklyRisk = 0;
  let monthlyRisk = 0;
  let hasLongWindowQuota = false;

  for (const w of limits.windows) {
    if (w.limit <= 0) continue;
    const key = w.window.toLowerCase();
    if (key === "5h" || key === "5_hour" || key === "5-hour") continue;

    const usageRatio = w.remaining / w.limit;                  // 0–1
    const resetMs = new Date(w.reset_at).getTime();
    const totalWindowMs = windowSizeMs(w.window);
    const timeLeftRatio = Math.max(
      0,
      Math.min(1, (resetMs - now) / totalWindowMs),
    );                                                          // 0–1
    const wasteRisk = usageRatio * (1 - timeLeftRatio);

    if (key === "weekly" || key === "7d") {
      weeklyRisk = wasteRisk;
      if (w.remaining > 0) hasLongWindowQuota = true;
    }
    if (key === "monthly" || key === "30d") {
      monthlyRisk = wasteRisk;
      if (w.remaining > 0) hasLongWindowQuota = true;
    }
  }

  let urgency =
    WEEKLY_WASTE_WEIGHT * weeklyRisk + MONTHLY_WASTE_WEIGHT * monthlyRisk;

  // Ensure a usable profile with remaining long-window quota always scores
  // > 0 so that `auto` can still pick it at the very start of a fresh
  // window (when wasteRisk ≈ 0 for everyone).
  if (urgency === 0 && hasLongWindowQuota) {
    urgency = 0.001;
  }

  return urgency;
}

/** Fetch limits for every saved profile in parallel. */
async function getAllProfileLimits(): Promise<ProfileLimits[]> {
  const config = await loadConfig();
  if (config.profiles.length === 0) {
    fail("No profiles yet. Add one with: droidx add <name>");
  }

  const tasks = config.profiles.map(async (name) => {
    const apiKey = await keytar.getPassword(SERVICE_NAME, name);
    if (apiKey === null) {
      return { name, apiKey: "", windows: [], error: "no API key in Keychain" } as ProfileLimits;
    }
    return fetchLimits(name, apiKey);
  });

  return Promise.all(tasks);
}

// ---------------------------------------------------------------------------
// status command
// ---------------------------------------------------------------------------

function pctStr(remaining: number, limit: number): string {
  if (limit <= 0) return "  -  ";
  const pct = Math.round((remaining / limit) * 100);
  return `${remaining}/${limit} (${pct}%)`;
}

async function showStatus(): Promise<void> {
  const all = await getAllProfileLimits();

  // Score and sort.
  const scored: ScoredProfile[] = all
    .map((p) => ({ ...p, urgency: scoreProfile(p) }))
    .sort((a, b) => b.urgency - a.urgency);

  const bestName =
    scored.length > 0 && scored[0].urgency > 0 ? scored[0].name : null;

  // Find window columns present in data.
  const windowOrder = ["5h", "weekly", "monthly"];
  const findWindow = (ws: WindowInfo[], key: string): WindowInfo | undefined =>
    ws.find((w) => w.window.toLowerCase() === key);

  // Print.
  console.log();
  const hdr = [
    "Profile".padEnd(16),
    "5h Remaining".padEnd(16),
    "Weekly Remaining".padEnd(18),
    "Monthly Remaining".padEnd(19),
    "Urgency",
  ].join("  ");
  console.log(hdr);
  console.log("─".repeat(hdr.length));

  for (const p of scored) {
    if (p.error) {
      console.log(
        `${p.name.padEnd(16)}  ⚠  ${p.error}`,
      );
      continue;
    }

    const cols = windowOrder.map((key) => {
      const w = findWindow(p.windows, key);
      if (!w) return "-".padEnd(key === "monthly" ? 19 : key === "weekly" ? 18 : 16);
      return pctStr(w.remaining, w.limit).padEnd(
        key === "monthly" ? 19 : key === "weekly" ? 18 : 16,
      );
    });

    const marker = p.name === bestName ? " ★" : "";
    const urgStr = p.urgency >= 0 ? p.urgency.toFixed(2) : "  -";
    console.log(
      `${p.name.padEnd(16)}  ${cols.join("  ")}  ${urgStr}${marker}`,
    );
  }

  console.log();
  if (bestName) {
    console.log(`★ Recommended: ${bestName}`);
  } else {
    console.log("No available profiles.");
  }
}

// ---------------------------------------------------------------------------
// auto command
// ---------------------------------------------------------------------------

async function autoRun(
  commandArgs: string[],
  options: { dryRun?: boolean },
): Promise<void> {
  const all = await getAllProfileLimits();

  // Print warnings for failed profiles.
  for (const p of all) {
    if (p.error) {
      console.error(`⚠  ${p.name}: ${p.error}`);
    }
  }

  const scored: ScoredProfile[] = all
    .filter((p) => !p.error && p.windows.length > 0)
    .map((p) => ({ ...p, urgency: scoreProfile(p) }))
    .filter((p) => p.urgency > 0)
    .sort((a, b) => {
      if (b.urgency !== a.urgency) return b.urgency - a.urgency;
      // Tie-break: prefer more 5h remaining (short window is most urgent).
      const a5h = a.windows.find((w) => w.window === "5h")?.remaining ?? 0;
      const b5h = b.windows.find((w) => w.window === "5h")?.remaining ?? 0;
      if (b5h !== a5h) return b5h - a5h;
      return a.name.localeCompare(b.name);
    });

  if (scored.length === 0) {
    fail("All profiles are exhausted or unreachable.");
  }

  const best = scored[0];

  // Show a one-liner summary.
  const parts = best.windows.map(
    (w) => `${w.window}: ${w.remaining}/${w.limit}`,
  );
  console.log(`Using "${best.name}" — ${parts.join(", ")}`);

  if (options.dryRun) {
    console.log("(dry run — not launching droid)");
    return;
  }

  spawnDroid(best.apiKey, commandArgs);
}

const program = new Command();

program
  .name("droidx")
  .description(
    "Run Factory Droid with the best available API-key profile.\n\n" +
    "When invoked without a subcommand, droidx automatically picks the\n" +
    "profile with the most remaining quota and launches droid.",
  )
  .version("0.1.0")
  .argument("[commandArgs...]", "Arguments forwarded to droid (default mode)")
  .option("--dry-run", "Show which profile would be selected without launching droid")
  .allowExcessArguments()
  .hook("preAction", async () => {
    const config = await loadConfig();
    applySettings(config);
  })
  .action((commandArgs: string[] = [], options: { dryRun?: boolean }) =>
    autoRun(commandArgs, options),
  );

program
  .command("add <name>")
  .description("Save a Factory API key in macOS Keychain")
  .action(addProfile);

program
  .command("list")
  .alias("ls")
  .description("List saved profiles")
  .action(listProfiles);

program
  .command("remove <name>")
  .alias("rm")
  .description("Delete a saved profile")
  .action(removeProfile);

program
  .command("run <name> [commandArgs...]")
  .description("Run droid with the selected profile")
  .allowExcessArguments()
  .action((name: string, commandArgs: string[] = []) =>
    runDroid(name, commandArgs),
  );

program
  .command("status")
  .description("Show remaining quota for all profiles")
  .action(showStatus);

program
  .command("auto [commandArgs...]")
  .description(
    "Alias for default behavior: pick the best profile and run droid",
  )
  .option("--dry-run", "Show which profile would be selected without launching droid")
  .allowExcessArguments()
  .action((commandArgs: string[] = [], options: { dryRun?: boolean }) =>
    autoRun(commandArgs, options),
  );

// ---------------------------------------------------------------------------
// config command
// ---------------------------------------------------------------------------

const SETTING_KEYS: Record<string, { field: keyof Settings; desc: string; validate: (v: number) => string | null }> = {
  "weekly-weight": {
    field: "weeklyWeight",
    desc: "Weight for weekly waste risk (monthly = 1 − this value)",
    validate: (v) => (v < 0 || v > 1) ? "Must be between 0 and 1." : null,
  },
  "min-5h": {
    field: "min5hPct",
    desc: "5h remaining % below which a profile is unusable",
    validate: (v) => (v < 0 || v > 100) ? "Must be between 0 and 100." : null,
  },
};

const configCmd = program
  .command("config [key] [value]")
  .description("Show or update scoring settings (persisted to disk)")
  .addHelpText("after", `
Available keys:
  weekly-weight   Weight for weekly waste risk; monthly = 1 − this (default: ${DEFAULT_SETTINGS.weeklyWeight})
  min-5h          5h remaining % below which a profile is unusable (default: ${DEFAULT_SETTINGS.min5hPct})

Examples:
  droidx config                    Show current settings
  droidx config weekly-weight 0.8  Set weekly weight (monthly becomes 0.2)
  droidx config min-5h 20         Set 5h threshold to 20%
  droidx config reset              Reset all settings to defaults`)
  .action(async (key?: string, value?: string) => {
    const config = await loadConfig();
    if (!config.settings) config.settings = {};
    applySettings(config);

    // No args → show current settings.
    if (!key) {
      const ww = WEEKLY_WASTE_WEIGHT;
      console.log();
      console.log(`  weekly-weight  ${ww}  (monthly-weight = ${(1 - ww).toFixed(2)})`);
      console.log(`  min-5h         ${MIN_5H_REMAINING_PCT}`);
      console.log();
      return;
    }

    // Reset.
    if (key === "reset") {
      delete config.settings;
      await saveConfig(config);
      console.log("Settings reset to defaults.");
      return;
    }

    // Set a value.
    const meta = SETTING_KEYS[key];
    if (!meta) {
      fail(`Unknown setting "${key}". Available: ${Object.keys(SETTING_KEYS).join(", ")}`);
    }

    if (value === undefined) {
      // Show single key.
      const resolved = { weeklyWeight: WEEKLY_WASTE_WEIGHT, min5hPct: MIN_5H_REMAINING_PCT };
      console.log(`${key} = ${resolved[meta.field]}`);
      return;
    }

    const num = Number(value);
    if (Number.isNaN(num)) fail(`"${value}" is not a valid number.`);
    const err = meta.validate(num);
    if (err) fail(err);

    config.settings[meta.field] = num;
    await saveConfig(config);
    applySettings(config);

    if (meta.field === "weeklyWeight") {
      console.log(`weekly-weight = ${num}  (monthly-weight = ${(1 - num).toFixed(2)})`);
    } else {
      console.log(`${key} = ${num}`);
    }
  });

await program.parseAsync(process.argv);
