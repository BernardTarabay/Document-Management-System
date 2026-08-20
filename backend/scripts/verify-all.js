#!/usr/bin/env node
// Run every verify-*.js in turn and report one verdict.
//
// WHY THIS EXISTS
//
// There are thirty-one verification scripts in this directory -- more lines
// than the entire automated test suite -- and no way to run them as a set.
// Each had to be invoked by hand, one at a time, and the result read off the
// console. In practice that means they were written, run once on the day the
// feature landed, and never run again: nothing regressed loudly, because
// nothing was watching.
//
// Seven of them additionally exited 0 no matter what they found, including
// verify-agent-e2e, the only one wired into package.json -- so `npm run
// verify:agent` could not fail. That is fixed in the scripts themselves; this
// runner is the other half, and it is deliberately strict about exit codes
// because they are the only thing it can read.
//
// USAGE
//
//   npm run verify:all              every script, alphabetically
//   npm run verify:all -- search    only scripts whose name contains "search"
//   npm run verify:all -- --bail    stop at the first failure
//
// REQUIREMENTS: a running Postgres and Redis, and the same .env the server
// uses. These are integration tests against real infrastructure -- that is the
// point of them, and it is why they are not part of `npm test`.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const SCRIPTS_DIR = __dirname;

// Per-script ceiling. Several of these scan folders, extract text and wait on
// queues; a hung one must not hold the whole run open forever.
const TIMEOUT_MS = parseInt(process.env.VERIFY_TIMEOUT_MS || "180000", 10);

const args = process.argv.slice(2);
const bail = args.includes("--bail");
const filters = args.filter((a) => !a.startsWith("--"));

function scriptsToRun() {
  const all = fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => f.startsWith("verify-") && f.endsWith(".js"))
    // Not itself.
    .filter((f) => f !== "verify-all.js")
    .sort();

  if (filters.length === 0) return all;
  return all.filter((f) => filters.some((needle) => f.includes(needle)));
}

function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, file)], {
      cwd: path.resolve(SCRIPTS_DIR, ".."),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      out += `\n[verify:all] killed after ${TIMEOUT_MS}ms\n`;
    }, TIMEOUT_MS);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        file,
        // A script killed on timeout reports a null code; that is a failure,
        // not an unknown.
        code: code === null ? 124 : code,
        signal,
        ms: Date.now() - started,
        output: out,
      });
    });
  });
}

(async () => {
  const files = scriptsToRun();
  if (files.length === 0) {
    console.error(`No verify scripts matched ${JSON.stringify(filters)}.`);
    process.exitCode = 1;
    return;
  }

  console.log(`[verify:all] running ${files.length} script(s), ${TIMEOUT_MS / 1000}s timeout each\n`);

  const results = [];
  for (const file of files) {
    process.stdout.write(`  ${file.padEnd(38)}`);
    const result = await runOne(file);
    results.push(result);

    const seconds = (result.ms / 1000).toFixed(1);
    if (result.code === 0) {
      console.log(`PASS  ${seconds}s`);
    } else if (result.code === 124) {
      console.log(`TIMEOUT  ${seconds}s`);
    } else {
      console.log(`FAIL (exit ${result.code})  ${seconds}s`);
    }

    if (result.code !== 0 && bail) {
      console.log("\n[verify:all] --bail: stopping at the first failure.\n");
      break;
    }
  }

  const failures = results.filter((r) => r.code !== 0);

  if (failures.length > 0) {
    console.log(`\n${"=".repeat(72)}`);
    console.log(`OUTPUT FROM THE ${failures.length} FAILING SCRIPT(S)`);
    console.log("=".repeat(72));
    for (const f of failures) {
      console.log(`\n----- ${f.file} (exit ${f.code}) ${"-".repeat(Math.max(0, 50 - f.file.length))}`);
      // Tail rather than the whole thing: these scripts are chatty and the
      // verdict is always at the end.
      const lines = f.output.split("\n");
      console.log(lines.slice(-40).join("\n").trimEnd());
    }
  }

  const passed = results.length - failures.length;
  console.log(`\n${"=".repeat(72)}`);
  console.log(`[verify:all] ${passed} passed, ${failures.length} failed, of ${results.length} run`);
  if (failures.length > 0) {
    console.log(`[verify:all] failing: ${failures.map((f) => f.file.replace(/^verify-|\.js$/g, "")).join(", ")}`);
  }
  console.log("=".repeat(72));

  process.exitCode = failures.length === 0 ? 0 : 1;
})();
