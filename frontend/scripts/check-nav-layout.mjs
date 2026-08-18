// Checks the header's saved arrangement against the things that actually break
// it -- which are all versions of "the app changed after the layout was saved".
//
// A stored nav layout is the longest-lived state this frontend has. It sits in
// somebody's browser across every future release, so the interesting cases are
// not "does dragging work" but "what happens to this layout when a destination
// is removed, added, or becomes forbidden". None of those are reachable by
// clicking around today, and all of them are one release away.
//
//   node scripts/check-nav-layout.mjs

import { resolveNav, toStored, pinAt, unpin, reorder } from "../src/lib/navLayout.js";

let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

const ITEMS = [
  { to: "/", label: "Library", defaultPrimary: true },
  { to: "/files", label: "Files", defaultPrimary: true },
  { to: "/duplicates", label: "Duplicates", defaultPrimary: true, permission: "duplicate.manage" },
  { to: "/dashboard", label: "Dashboard" },
  { to: "/users", label: "Users", permission: "user.manage" },
];
const keys = (list) => list.map((i) => i.to);
const all = () => true;

console.log("Header layout\n" + "=".repeat(46));

console.log("\n1. Before anyone rearranges anything");
{
  const { primary, secondary } = resolveNav(ITEMS, null, all);
  check("the shipped split is the default",
    JSON.stringify(keys(primary)) === JSON.stringify(["/", "/files", "/duplicates"]),
    keys(primary).join(", "));
  check("everything else is in More",
    JSON.stringify(keys(secondary)) === JSON.stringify(["/dashboard", "/users"]),
    keys(secondary).join(", "));
}

console.log("\n2. Rearranging");
{
  // The complaint that started this: Dashboard was two clicks away with no way
  // to change that.
  const pinned = pinAt(["/", "/files"], "/dashboard", 0);
  const { primary, secondary } = resolveNav(ITEMS, pinned, all);
  check("a folder from More can lead the header",
    keys(primary)[0] === "/dashboard", keys(primary).join(", "));
  check("...and it is no longer listed in More",
    !keys(secondary).includes("/dashboard"), keys(secondary).join(", ") || "(empty)");

  check("dropping onto the left half of a target inserts before it",
    JSON.stringify(reorder(["/", "/files", "/dashboard"], "/dashboard", "/files", true))
      === JSON.stringify(["/", "/dashboard", "/files"]));
  check("dropping onto the right half inserts after it",
    JSON.stringify(reorder(["/", "/files", "/dashboard"], "/dashboard", "/files", false))
      === JSON.stringify(["/", "/files", "/dashboard"]));

  // Dragging rightwards is where an off-by-one hides: the index has to be
  // computed after the dragged item is removed, or it lands one slot short.
  check("dragging an item rightwards lands where the gap opens",
    JSON.stringify(reorder(["/a", "/b", "/c"], "/a", "/c", false))
      === JSON.stringify(["/b", "/c", "/a"]),
    reorder(["/a", "/b", "/c"], "/a", "/c", false).join(", "));

  check("an item cannot be duplicated by dropping it on itself",
    JSON.stringify(reorder(["/", "/files"], "/files", "/files", true))
      === JSON.stringify(["/", "/files"]));
  check("pinning something already pinned moves it, it does not clone it",
    JSON.stringify(pinAt(["/", "/files"], "/", 1)) === JSON.stringify(["/files", "/"]),
    pinAt(["/", "/files"], "/", 1).join(", "));
  check("unpinning returns it to More", !resolveNav(ITEMS, unpin(["/", "/files"], "/files"), all)
    .primary.some((i) => i.to === "/files"));
}

console.log("\n3. The layout outlives the release that made it");
{
  // A destination that no longer exists must not render as a dead link.
  const { primary } = resolveNav(ITEMS, ["/", "/removed-last-year", "/files"], all);
  check("a destination that no longer exists is ignored",
    JSON.stringify(keys(primary)) === JSON.stringify(["/", "/files"]),
    keys(primary).join(", "));

  // A destination added after the user customised cannot appear uninvited --
  // that would silently undo their arrangement -- but it must not vanish.
  const withNew = [...ITEMS, { to: "/reports", label: "Reports", defaultPrimary: true }];
  const { primary: p2, secondary: s2 } = resolveNav(withNew, ["/", "/files"], all);
  check("a NEW destination does not barge onto a customised header",
    !keys(p2).includes("/reports"), keys(p2).join(", "));
  check("...but it is still reachable in More, not lost",
    keys(s2).includes("/reports"), keys(s2).join(", "));

  // A layout is not an entitlement.
  const canSee = (perm) => perm !== "duplicate.manage" && perm !== "user.manage";
  const { primary: p3, secondary: s3 } = resolveNav(ITEMS, ["/", "/duplicates", "/files"], canSee);
  check("a pinned destination the user may not see is filtered out",
    !keys(p3).includes("/duplicates"), keys(p3).join(", "));
  check("...and does not reappear in More either",
    !keys(s3).includes("/duplicates"), keys(s3).join(", ") || "(empty)");

  // Storage is user-editable and can be corrupt.
  const { primary: p4 } = resolveNav(ITEMS, ["/", "/", "/files"], all);
  check("a duplicated key in stored state renders once",
    JSON.stringify(keys(p4)) === JSON.stringify(["/", "/files"]), keys(p4).join(", "));

  const { primary: p5, secondary: s5 } = resolveNav(ITEMS, [], all);
  check("an empty header is allowed -- everything simply lives in More",
    p5.length === 0 && s5.length === 5, `${p5.length} on header, ${s5.length} in More`);
}

console.log("\n4. Round trip");
{
  const { primary } = resolveNav(ITEMS, ["/files", "/"], all);
  check("what is rendered is what gets stored",
    JSON.stringify(toStored(primary)) === JSON.stringify(["/files", "/"]),
    toStored(primary).join(", "));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
