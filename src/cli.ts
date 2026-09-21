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

type Config = {
  profiles: string[];
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
    return { profiles: parsed.profiles };
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

const program = new Command();

program
  .name("droidx")
  .description("Run Factory Droid with a selected API-key profile.")
  .version("0.1.0");

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

if (process.argv.length <= 2) {
  program.help();
} else {
  await program.parseAsync(process.argv);
}
