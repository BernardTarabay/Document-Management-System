// The folder picker is reachable by any account holding `storage.manage`,
// which is every ordinary user. What keeps that safe is not the permission --
// it is that browsing is CONFINED to an explicit set of roots.
//
// These test the containment predicate directly, because the ways it fails
// are all quiet: a prefix test without a separator lets `/home/meevil` pass a
// `/home/me` root, and a check applied after the stat leaks whether a path
// exists even while refusing to list it.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const os = require("os");

const { isWithinRoots, browseRoots } = require("../src/services/filesystemBrowseService");

const IS_WINDOWS = process.platform === "win32";
const ROOT = IS_WINDOWS ? "C:\\Users\\me" : "/home/me";
const roots = [ROOT];

test("a root contains itself and its descendants", () => {
  assert.equal(isWithinRoots(ROOT, roots), true);
  assert.equal(isWithinRoots(path.join(ROOT, "Desktop"), roots), true);
  assert.equal(isWithinRoots(path.join(ROOT, "Desktop", "Scans", "2025"), roots), true);
});

test("a sibling whose name merely starts with the root is NOT inside it", () => {
  // The classic defeat of a naive startsWith: "/home/meevil" begins with
  // "/home/me". The separator suffix is what closes it.
  assert.equal(isWithinRoots(`${ROOT}evil`, roots), false);
  assert.equal(isWithinRoots(`${ROOT}-backup`, roots), false);
});

test("traversal cannot climb out", () => {
  // path.resolve collapses "..", so the check sees the real destination
  // rather than the string the caller sent.
  const escapes = [
    path.join(ROOT, "..", "otheruser"),
    path.join(ROOT, "Desktop", "..", "..", "otheruser"),
    path.join(ROOT, "..", "..", IS_WINDOWS ? "Windows" : "etc"),
  ];
  for (const attempt of escapes) {
    assert.equal(isWithinRoots(attempt, roots), false, attempt);
  }
});

test("an unrelated absolute path is refused", () => {
  const outside = IS_WINDOWS ? "C:\\Windows\\System32" : "/etc";
  assert.equal(isWithinRoots(outside, roots), false);
});

test("null roots means no confinement, and says so explicitly", () => {
  // BROWSE_ROOTS=* -- a deliberate, documented choice for a single-user
  // machine, not the accident of an absent config.
  const outside = IS_WINDOWS ? "C:\\Windows" : "/etc";
  assert.equal(isWithinRoots(outside, null), true);
});

test("several roots are honoured independently", () => {
  const second = IS_WINDOWS ? "E:\\Archive" : "/mnt/archive";
  const both = [ROOT, second];
  assert.equal(isWithinRoots(path.join(second, "2019"), both), true);
  assert.equal(isWithinRoots(path.join(ROOT, "Desktop"), both), true);
  assert.equal(isWithinRoots(IS_WINDOWS ? "D:\\Other" : "/mnt/other", both), false);
});

if (IS_WINDOWS) {
  test("Windows path comparison ignores case", () => {
    // c:\users\me and C:\Users\Me are the same directory, and the picker
    // itself produces both spellings -- a case-sensitive compare would refuse
    // paths it had just handed out.
    assert.equal(isWithinRoots("c:\\users\\me\\desktop", roots), true);
    assert.equal(isWithinRoots("C:\\USERS\\ME\\Desktop", roots), true);
  });
}

test("the default is UNCONFINED -- a desktop app must see its own drives", () => {
  // This reversed a first attempt that defaulted to $HOME. On a normal
  // Windows install that filtered out every drive letter including C:\, so
  // the picker offered no drives at all and a folder on D:\ was unreachable.
  // Defending against a second account that does not exist, by breaking the
  // application for the one that does, is the wrong trade -- so confinement is
  // opt-in and the risk is warned about at boot once it is real.
  const saved = process.env.BROWSE_ROOTS;
  delete process.env.BROWSE_ROOTS;
  try {
    assert.equal(browseRoots(), null, "no confinement unless configured");
    const anywhere = IS_WINDOWS ? "D:\\Archive" : "/mnt/archive";
    assert.equal(isWithinRoots(anywhere, browseRoots()), true);
  } finally {
    if (saved === undefined) delete process.env.BROWSE_ROOTS;
    else process.env.BROWSE_ROOTS = saved;
  }
});

test("BROWSE_ROOTS=* is the same as unset, stated explicitly", () => {
  const saved = process.env.BROWSE_ROOTS;
  process.env.BROWSE_ROOTS = "*";
  try {
    assert.equal(browseRoots(), null);
  } finally {
    if (saved === undefined) delete process.env.BROWSE_ROOTS;
    else process.env.BROWSE_ROOTS = saved;
  }
});

test("setting BROWSE_ROOTS confines, and a drive outside it is refused", () => {
  const saved = process.env.BROWSE_ROOTS;
  process.env.BROWSE_ROOTS = ROOT;
  try {
    const roots = browseRoots();
    assert.deepEqual(roots, [ROOT]);
    const other = IS_WINDOWS ? "D:\\Archive" : "/mnt/archive";
    assert.equal(isWithinRoots(other, roots), false);
    assert.equal(isWithinRoots(path.join(ROOT, "Desktop"), roots), true);
  } finally {
    if (saved === undefined) delete process.env.BROWSE_ROOTS;
    else process.env.BROWSE_ROOTS = saved;
  }
});
