// Creates a shortcut that points at a file living somewhere else.
//
// Why shortcuts and not copies or moves: the files being organized are
// somebody's real working documents, spread across iCloud, local disks and
// external drives, hundreds of gigabytes, irreplaceable. Copying doubles
// the storage and immediately goes stale; moving risks destroying data when
// a volume goes offline mid-operation, and pulling a file out of its iCloud
// folder silently removes it from the backup it was relying on. A shortcut
// costs a few hundred bytes, cannot corrupt the target, and if the whole
// mirror tree is deleted nothing is lost -- it regenerates from the
// database.
//
// Platform split:
//  - Windows: a real .lnk, written through WScript.Shell. Symlinks would be
//    cleaner but need Developer Mode or an elevated process on Windows,
//    which is not a reasonable thing to require of the person using this.
//    .lnk files work for any user, and Explorer treats them as first-class.
//  - macOS/Linux: a plain symlink, which is the native equivalent and needs
//    no privilege.
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const IS_WINDOWS = process.platform === "win32";
const SHORTCUT_EXTENSION = IS_WINDOWS ? ".lnk" : "";

// One PowerShell process handles a whole batch. Spawning one per shortcut
// costs ~100ms of interpreter startup each, which across thousands of files
// is the difference between seconds and half an hour.
const POWERSHELL_TIMEOUT_MS = 120_000;

class ShortcutError extends Error {}

function shortcutNameFor(canonicalFilename) {
  // The .lnk suffix goes AFTER the document's own extension, so Explorer
  // still shows "Report 2026.pdf" with a shortcut arrow, and the
  // originating type stays visible in the name.
  return `${canonicalFilename}${SHORTCUT_EXTENSION}`;
}

// PowerShell does not only accept the ASCII apostrophe as a string
// delimiter. It also accepts the typographic quotes -- U+2018, U+2019,
// U+201A, U+201B -- as fully equivalent. Word's autocorrect turns every
// apostrophe it types into U+2019, so titles pulled out of French .doc
// metadata are full of them ("Maison d'accueil").
//
// Escaping only U+0027 therefore looked correct and was not: one U+2019 in
// one filename terminated its string early and broke the parse of the whole
// generated script. Because the entire batch is one .ps1, that meant NONE of
// the several thousand shortcuts in that run were created -- the mirror
// simply stopped working, with a syntax error pointing at a filename as the
// only clue.
const PS_QUOTE_CHARS = new Set([0x0027, 0x2018, 0x2019, 0x201a, 0x201b]);

function powershellQuote(value) {
  let out = "'";
  for (const ch of String(value)) {
    out += PS_QUOTE_CHARS.has(ch.codePointAt(0)) ? ch + ch : ch;
  }
  return `${out}'`;
}

/**
 * Write many Windows shortcuts in one PowerShell invocation.
 * @param {{shortcutPath: string, targetPath: string, description?: string}[]} entries
 */
async function writeWindowsShortcuts(entries) {
  if (entries.length === 0) return { written: 0, errors: [] };

  const lines = [
    "$ErrorActionPreference = 'Continue'",
    "$sh = New-Object -ComObject WScript.Shell",
  ];
  for (const [i, entry] of entries.entries()) {
    // WScript.Shell cannot SAVE to a path containing characters outside the
    // system ANSI code page. On an English-locale Windows that means every
    // Arabic and Hebrew filename in this repository fails with "Unable to
    // save shortcut" -- a large share of the corpus, silently absent from
    // the organized folder.
    //
    // The COM object is still the only practical way to author a .lnk, so
    // it writes to an ASCII scratch path and .NET moves the result into
    // place. Move-Item goes through the .NET file APIs, which are fully
    // Unicode, so the destination name is no longer WSH's problem.
    const needsAsciiHop = /[^\x00-\x7F]/.test(entry.shortcutPath);
    const authorPath = needsAsciiHop
      ? path.join(os.tmpdir(), `dms-lnk-${process.pid}-${i}.lnk`)
      : entry.shortcutPath;

    lines.push(
      "try {",
      `  $lnk = $sh.CreateShortcut(${powershellQuote(authorPath)})`,
      `  $lnk.TargetPath = ${powershellQuote(entry.targetPath)}`,
      `  $lnk.WorkingDirectory = ${powershellQuote(path.dirname(entry.targetPath))}`,
      `  $lnk.Description = ${powershellQuote((entry.description || "").slice(0, 240))}`,
      "  $lnk.Save()"
    );
    if (needsAsciiHop) {
      lines.push(
        `  Move-Item -LiteralPath ${powershellQuote(authorPath)} -Destination ${powershellQuote(entry.shortcutPath)} -Force`
      );
    }
    lines.push(
      "} catch {",
      `  Write-Output ("FAILED\`t" + ${powershellQuote(entry.shortcutPath)} + "\`t" + $_.Exception.Message)`,
      "}"
    );
  }

  // Written to a temp .ps1 rather than passed with -Command: a few thousand
  // shortcuts blows past the command-line length limit.
  //
  // The BOM is load-bearing, not decoration. Windows PowerShell 5.1 reads a
  // .ps1 as ANSI unless it starts with a UTF-8 byte-order mark -- so
  // "Conférence" arrives as "ConfÃ©rence", the shortcut lands at a path
  // nobody expects, and the next prune deletes it as unrecognized. That
  // failure is invisible: the script reports success, the shortcut count
  // looks right, and the file is simply missing from the tree. Every
  // non-ASCII name in this repository (French, Arabic, Hebrew) depends on
  // these three bytes.
  const scriptPath = path.join(os.tmpdir(), `dms-mirror-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  await fsp.writeFile(scriptPath, "﻿" + lines.join("\n"), "utf8");

  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
        (err, out) => (err && !out ? reject(new ShortcutError(err.message)) : resolve(out || ""))
      );
    });

    const errors = stdout
      .split(/\r?\n/)
      .filter((l) => l.startsWith("FAILED\t"))
      .map((l) => {
        const [, shortcutPath, message] = l.split("\t");
        return { shortcutPath, message };
      });

    return { written: entries.length - errors.length, errors };
  } finally {
    await fsp.rm(scriptPath, { force: true }).catch(() => {});
  }
}

async function writePosixSymlinks(entries) {
  const errors = [];
  let written = 0;
  for (const entry of entries) {
    try {
      await fsp.rm(entry.shortcutPath, { force: true });
      await fsp.symlink(entry.targetPath, entry.shortcutPath);
      written += 1;
    } catch (err) {
      errors.push({ shortcutPath: entry.shortcutPath, message: err.message });
    }
  }
  return { written, errors };
}

async function writeShortcuts(entries) {
  return IS_WINDOWS ? writeWindowsShortcuts(entries) : writePosixSymlinks(entries);
}

module.exports = { writeShortcuts, shortcutNameFor, SHORTCUT_EXTENSION, IS_WINDOWS, ShortcutError };
