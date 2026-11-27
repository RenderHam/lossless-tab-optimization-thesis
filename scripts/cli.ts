#!/usr/bin/env bun
/**
 * Cross-platform task runner for the thesis project.
 *
 * Every OS-specific launcher (scripts/bootstrap.sh / .ps1 / .cmd) ends up
 * here, so the actual commands only exist once. Run with:
 *
 *   bun scripts/cli.ts <command> [args...]
 *   bun run <script>          (package.json delegates here)
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const COMMANDS = [
  "setup", "dev", "test", "typecheck", "build", "preview",
  "verify", "report", "summary", "doctor", "help",
] as const;

type Command = (typeof COMMANDS)[number];

function run(bin: string, args: string[] = [], cwd: string = ROOT): number {
  const result = spawnSync(bin, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(`Could not run ${bin}: ${result.error.message}`);
    return 127;
  }
  return result.status ?? 1;
}

function runStream(bin: string, args: string[] = [], cwd: string = ROOT): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", (error) => {
      console.error(`Could not run ${bin}: ${error.message}`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function chromeCandidates(): string[] {
  if (process.platform === "win32") {
    const roots = [
      process.env["PROGRAMFILES"],
      process.env["PROGRAMFILES(X86)"],
      join(homedir(), "AppData", "Local"),
    ].filter(Boolean) as string[];
    const suffixes = [
      join("Google", "Chrome", "Application", "chrome.exe"),
      join("Google", "Chrome SxS", "Application", "chrome.exe"),
      join("Microsoft", "Edge", "Application", "msedge.exe"),
    ];
    const paths = roots.flatMap((root) => suffixes.map((s) => join(root, s)));
    return paths.concat([
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ]);
  }
  return [
    "google-chrome-unstable", "google-chrome", "google-chrome-stable",
    "chromium", "chromium-browser", "microsoft-edge",
  ];
}

function findChrome(): { path: string; how: string } | null {
  for (const candidate of chromeCandidates()) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) return { path: candidate, how: "known install location" };
    } else {
      const found = Bun.which(candidate);
      if (found) return { path: found, how: "PATH" };
    }
  }
  return null;
}

function diskFree(): string {
  if (process.platform === "win32") {
    const out = spawnSync("powershell.exe", [
      "-NoProfile", "-Command",
      "(Get-PSDrive -Name C).Free / 1GB",
    ], { encoding: "utf8" });
    return out.status === 0 ? `${out.stdout.trim()} GiB free on C:` : "unknown";
  }
  const out = spawnSync("df", ["-h", ROOT], { encoding: "utf8" });
  if (out.status !== 0) return "unknown";
  return out.stdout.trim().split("\n").slice(-1)[0]?.split(/\s+/).slice(3).join(" ") ?? "unknown";
}

function doctor(): void {
  console.log("Project doctor");
  console.log(`  OS:            ${process.platform} ${process.arch}`);
  console.log(`  Bun:           ${Bun.version} (${process.execPath})`);
  const chrome = findChrome();
  if (chrome) {
    console.log(`  Chrome/Edge:   ${chrome.path} (${chrome.how})`);
  } else {
    console.log("  Chrome/Edge:   NOT FOUND");
    console.log("    Install Google Chrome 160+ (dev channel recommended) or Edge.");
    console.log("    Windows: winget install Google.Chrome");
    console.log("    macOS:   brew install --cask google-chrome");
    console.log("    Linux:   https://www.google.com/chrome/ (or your package manager)");
    console.log("    Then re-run this command. The harness needs a real browser.");
  }
  console.log(`  Dependencies:  ${existsSync(join(ROOT, "node_modules")) ? "installed" : "missing — run 'bun install'"}`);
  console.log(`  Disk:          ${diskFree()}`);
  console.log("  Memory:        PSS via /proc on Linux; Working Set via PowerShell/CIM on Windows");
  console.log("  Note:          Windows and Linux memory numbers are not comparable.");
}

function help(): void {
  console.log(`Usage: bun scripts/cli.ts <command> [args...]\n`);
  console.log("Commands:");
  console.log("  setup       Install project dependencies with Bun, then run doctor");
  console.log("  dev         Start the Vite dev server");
  console.log("  test        Run all *.test.mjs / *.test.ts tests with Bun");
  console.log("  typecheck   Run the TypeScript compiler in check-only mode");
  console.log("  build       Typecheck, then build dist/");
  console.log("  preview     Preview the built extension");
  console.log("  verify      Run the recorded T01–T10 verification suite (needs Chrome)");
  console.log("  report      Regenerate a run report: report <run-id>");
  console.log("  summary     Regenerate results/verification/SUMMARY.md");
  console.log("  doctor      Show detected OS, Bun, Chrome and disk information");
  console.log("  help        Show this message\n");
  console.log("OS launchers: scripts/bootstrap.sh (Linux/macOS),");
  console.log("              scripts/bootstrap.ps1 / .cmd (Windows)");
}

/** The verification harness is TypeScript after the Bun migration. */
function verifyArgs(args: string[]): string[] {
  return args.length ? args : ["run", "--tests", "all"];
}

async function main(): Promise<number> {
  const [raw, ...rest] = process.argv.slice(2);
  const command = (raw ?? "help") as Command;
  if (!COMMANDS.includes(command)) {
    console.error(`Unknown command: ${command}. Run 'bun scripts/cli.ts help'.`);
    return 2;
  }

  switch (command) {
    case "help":
      help();
      return 0;
    case "doctor":
      doctor();
      return 0;
    case "setup":
      console.log("Installing dependencies with Bun...");
      return run("bun", ["install"]) || (doctor(), 0);
    case "dev":
      return runStream("bunx", ["vite"]);
    case "test":
      return run("bun", ["test", ...rest]);
    case "typecheck": {
      const status = run("bunx", ["tsc", "--noEmit"]);
      return status !== 0 ? status : run("bunx", ["tsc", "-p", "tools/tsconfig.json"]);
    }
    case "build": {
      const status = run("bunx", ["tsc", "--noEmit"]);
      return status !== 0 ? status : run("bunx", ["vite", "build"]);
    }
    case "preview":
      return runStream("bunx", ["vite", "preview", ...rest]);
    case "verify": {
      const harness = join(ROOT, "tools", "thesis-verify", "verify.ts");
      if (!existsSync(harness)) {
        console.error("TypeScript verification harness is missing.");
        return 1;
      }
      return run("bun", [harness, ...verifyArgs(rest)]);
    }
    case "report":
    case "summary": {
      const harness = join(ROOT, "tools", "thesis-verify", "verify.ts");
      if (!existsSync(harness)) {
        console.error("TypeScript verification harness is missing.");
        return 1;
      }
      return run("bun", [harness, command, ...rest]);
    }
  }
}

process.exit(await main());
