// Refuses to start the dev API when something already owns its port.
//
// WHY THIS EXISTS
//
// `npm run dev` and a production-style `node src/server.js` are both easy to
// start and neither knows about the other. When both are up, the second one
// loses the race for the port -- and nodemon's response to EADDRINUSE is to
// print the crash and then sit quietly waiting for a file change. There is a
// running API, on the right port, answering /api/health with `status: ok`. It
// is simply the OTHER one, frozen at whatever the code looked like when it
// started.
//
// The symptom that produces is genuinely baffling: a feature works in the
// source, its route is registered, its tests pass, and the browser 404s. A
// whole debugging session went into a Document Types page that was never
// broken -- the API answering the browser had been started the previous day,
// before that route existed. Editing files fixes nothing, because nothing is
// reading them.
//
// scripts\restart-atlas.bat already guards the reverse direction (it refuses
// to start production while a dev server is up). This is the missing half.
//
// The check is deliberately a REFUSAL and not a warning. A warning scrolls
// past in the same terminal noise that hid the original crash, and the whole
// failure mode is that everything looks fine.
//
//   SKIP_PREFLIGHT=1 npm run dev    to start anyway (two APIs, on purpose)

const net = require("net");
const { execFileSync } = require("child_process");

require("dotenv").config();

const PORT = parseInt(process.env.PORT || "5000", 10);

/**
 * Is anything listening here?
 *
 * Asked by trying to bind rather than by parsing `netstat`, because binding is
 * the same question the server itself is about to ask, answered by the same
 * kernel. A parser can disagree with reality (IPv4 vs IPv6, a socket in
 * TIME_WAIT, a different loopback alias); a bind cannot.
 *
 * NO HOST IS SPECIFIED, AND THAT IS THE LOAD-BEARING PART.
 *
 * `server.js` calls `app.listen(port)` with no host, which binds the dual-stack
 * wildcard. The probe has to make the identical call, because on Windows the
 * result genuinely differs: with another process already holding the port,
 *
 *     listen({ port, host: "0.0.0.0" })  ->  succeeds  (reports FREE, wrongly)
 *     listen({ port })                   ->  EADDRINUSE
 *
 * The first version of this check specified "0.0.0.0" to be explicit, and it
 * silently passed against a port that was demonstrably occupied -- a preflight
 * that always says "all clear" is worse than no preflight, because it is also
 * a reason to stop suspecting the port. `exclusive: true` is kept so the probe
 * cannot quietly share the port via SO_REUSEADDR.
 */
function portIsBusy(port) {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once("error", (err) => resolve(err.code === "EADDRINUSE" || err.code === "EACCES"))
      .once("listening", () => tester.close(() => resolve(false)))
      .listen({ port, exclusive: true });
  });
}

/**
 * Whatever we can find out about the process holding the port -- best effort,
 * and never fatal.
 *
 * Identifying the squatter is the difference between "port 5000 is busy",
 * which the developer already suspected, and "PID 14436, started yesterday at
 * 02:06, running `node src/server.js`", which tells them what to kill and why
 * it is stale. Every failure here is swallowed: an unidentifiable process must
 * still produce the refusal, just a less specific one.
 */
function describeHolder(port) {
  try {
    if (process.platform === "win32") {
      // The PARENT's command line is fetched too, and it is what makes the
      // diagnosis correct rather than merely confident. nodemon runs the server
      // by spawning `node src/server.js` -- character for character what a
      // production start looks like -- so the holder alone cannot tell the two
      // apart, and guessing from it told a developer with a perfectly healthy
      // dev server that their edits would not appear.
      const ps =
        `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
        `if ($c) { $p = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $c.OwningProcess); ` +
        `if ($p) { $par = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $p.ParentProcessId) -ErrorAction SilentlyContinue; ` +
        `"$($p.ProcessId)|$($p.CreationDate)|$($p.CommandLine)|$($par.CommandLine)" } }`;
      const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000,
      }).trim();
      if (!out) return null;
      const [pid, created, command, parentCommand] = out.split("|");
      return {
        pid,
        started: created || null,
        command: command || null,
        parentCommand: parentCommand || null,
      };
    }

    // macOS / Linux
    const pid = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000,
    }).trim().split("\n")[0];
    if (!pid) return null;
    const command = execFileSync("ps", ["-p", pid, "-o", "command="], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000,
    }).trim();
    let parentCommand = null;
    try {
      const ppid = execFileSync("ps", ["-p", pid, "-o", "ppid="], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000,
      }).trim();
      parentCommand = execFileSync("ps", ["-p", ppid, "-o", "command="], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000,
      }).trim() || null;
    } catch { /* parent is optional -- the refusal stands without it */ }
    return { pid, started: null, command: command || null, parentCommand };
  } catch {
    return null;
  }
}

/** A Windows CIM date (20260815020655.123456+180) as something a human reads. */
function humanDate(raw) {
  if (!raw) return null;
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleString();
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(raw));
  if (!m) return String(raw);
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).toLocaleString();
}

(async () => {
  if (process.env.SKIP_PREFLIGHT === "1") {
    console.log("preflight: skipped (SKIP_PREFLIGHT=1)");
    return;
  }

  if (!(await portIsBusy(PORT))) return; // the common case: nothing to say

  const holder = describeHolder(PORT);
  const killCommand = (pid) =>
    process.platform === "win32" ? `taskkill /PID ${pid} /F` : `kill ${pid}`;
  // Setting an env var for one command is shell-specific, and this script's
  // whole job is to not waste someone's afternoon, so it prints the form that
  // works in the shell they are actually in.
  const skipHint =
    process.platform === "win32"
      ? '$env:SKIP_PREFLIGHT=1; npm run dev     (PowerShell)\n    set SKIP_PREFLIGHT=1 && npm run dev    (cmd)'
      : "SKIP_PREFLIGHT=1 npm run dev";

  const lines = [
    "",
    `  Port ${PORT} is already in use, so the dev API cannot start.`,
    "",
  ];

  if (holder) {
    lines.push(`  Held by PID ${holder.pid}`);
    if (holder.started) lines.push(`    started:  ${humanDate(holder.started)}`);
    if (holder.command) lines.push(`    command:  ${holder.command.trim()}`);
    lines.push("");
    // The distinction that matters, and the reason the parent is looked up.
    // A second `npm run dev` is a harmless mistake -- there is a reloading
    // server there and you can just use it. A bare `node src/server.js` is the
    // one that silently serves stale code for as long as it is up, which is
    // the failure this whole script exists for.
    const underNodemon = /nodemon/i.test(`${holder.command || ""} ${holder.parentCommand || ""}`);
    if (underNodemon) {
      lines.push("  That is another dev server (nodemon), so it does reload on edits --");
      lines.push("  you already have one running and probably want to use it rather than");
      lines.push("  start a second.");
      lines.push("");
      // Killing this pid would accomplish nothing: it is nodemon's child, and
      // nodemon exists to start another one the moment it dies.
      lines.push("  To stop it, press Ctrl+C in the terminal running `npm run dev` --");
      lines.push(`  killing PID ${holder.pid} directly will not work, because nodemon will`);
      lines.push("  simply restart it.");
    } else if (/server\.js/i.test(holder.command || "")) {
      lines.push("  That is a PRODUCTION-style server (no reload). It will keep serving the");
      lines.push("  code it started with, so edits you make now will not appear in the browser");
      lines.push("  and routes added since it started will 404.");
      lines.push("");
      lines.push(`  Stop it and try again:   ${killCommand(holder.pid)}`);
    } else {
      lines.push(`  Stop it and try again:   ${killCommand(holder.pid)}`);
    }
  } else {
    lines.push("  Could not identify the process holding it.");
    lines.push(`  Find it with:   ${process.platform === "win32"
      ? `netstat -ano | findstr :${PORT}`
      : `lsof -i tcp:${PORT}`}`);
  }

  lines.push(
    "",
    "  Or start anyway (two APIs, and only one of them wins the port):",
    `    ${skipHint}`,
    ""
  );

  console.error(lines.join("\n"));
  process.exitCode = 1;
})();
