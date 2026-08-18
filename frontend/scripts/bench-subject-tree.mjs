// Measures the Library's folder-pane work at a real archive's size.
//
// The brief for this was "verify tree filtering doesn't do O(n) full-tree work
// on every keystroke at this scale -- profile against a generated fixture,
// don't guess at performance". This is that profile. It runs the actual
// shipped functions from src/lib/subjectTree.js against a synthetic taxonomy
// of the stated size, alongside a copy of the OLD implementation, so the
// numbers are a comparison rather than an assertion.
//
//   node scripts/bench-subject-tree.mjs
//   node scripts/bench-subject-tree.mjs --subjects 55000 --depth 5
//
// What matters here is not the absolute milliseconds -- they depend on the
// machine -- but the two ratios: filtering per keystroke, and how much work a
// render does when nothing is being searched.

import { performance } from "node:perf_hooks";
import { buildTree, buildTreeIndex, matchSubjects, flattenVisible } from "../src/lib/subjectTree.js";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? Number(args[i + 1]) : fallback;
};

const SUBJECTS = argOf("subjects", 55000);
const DEPTH = argOf("depth", 5);

// Folder names a real archive actually contains: accented French, Arabic, the
// user's own inventions, and enough repetition that a search term matches a
// lot of them. A vocabulary of unique ASCII words would make the substring
// search look faster than it is.
const WORDS = [
  "Factures", "Contrats", "Comptabilité", "Rapports", "Procès-verbaux",
  "مراسلات", "تقارير", "فواتير",
  "Tables", "Boat stuff", "Scans", "Inbox", "Misc", "Archive", "Photos",
  "2019", "2020 - Q3 - reconciled", "Old NAS", "À classer", "Divers",
];

const ROOTS = argOf("roots", 24);

/**
 * A tree shaped like somebody's actual archive: a couple of dozen top-level
 * folders and everything else nested beneath them.
 *
 * The first version of this generator picked a random depth per node, which
 * produced 11,105 top-level folders out of 55,000 -- a shape no filing system
 * has, and one that flattered the numbers by making most of the tree reachable
 * without expanding anything. Rooting the tree properly is what exposed the
 * cost of a search that matches near the root.
 */
function makeSubjects(count, maxDepth) {
  const flat = [];
  const byDepth = [];
  let i = 0;

  const push = (parent, depth) => {
    const node = { id: `s-${i}`, parent_id: parent ? parent.id : null, name: `${WORDS[i % WORDS.length]} ${i}` };
    flat.push(node);
    if (!byDepth[depth]) byDepth[depth] = [];
    byDepth[depth].push(node);
    i += 1;
    return node;
  };

  for (let r = 0; r < Math.min(ROOTS, count); r += 1) push(null, 0);

  while (flat.length < count) {
    // Bias toward the shallower levels, the way real trees fan out.
    const depth = 1 + Math.floor(Math.random() * (maxDepth - 1));
    const pool = byDepth[depth - 1];
    if (!pool?.length) continue;
    push(pool[Math.floor(Math.random() * pool.length)], depth);
  }
  return flat;
}

// ---------------------------------------------------------------------------
// The OLD implementation, copied verbatim from LibraryPage.jsx before this
// change, so the comparison is against what actually shipped rather than
// against a strawman.
function oldFilterTree(nodes, term) {
  const needle = term.trim().toLowerCase();
  if (!needle) return nodes;
  const walk = (list) =>
    list.reduce((kept, node) => {
      const selfMatches = node.name.toLowerCase().includes(needle);
      const children = selfMatches ? node.children : walk(node.children);
      if (selfMatches || children.length > 0) kept.push({ ...node, children });
      return kept;
    }, []);
  return walk(nodes);
}

/** How many React rows the old recursive tree would have mounted. */
function countRenderedNodes(nodes, depth = 0) {
  // Branches started open only at depth 0, and every open branch rendered all
  // of its children -- so this is roots + their immediate children.
  let n = 0;
  for (const node of nodes) {
    n += 1;
    if (depth === 0) n += node.children.length;
  }
  return n;
}

const ms = (fn, runs = 5) => {
  fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < runs; i += 1) fn();
  return (performance.now() - t0) / runs;
};

const fmt = (n) => `${n.toFixed(2)} ms`;

console.log(`Library folder pane, ${SUBJECTS.toLocaleString()} folders, max depth ${DEPTH}`);
console.log("=".repeat(66));

const flat = makeSubjects(SUBJECTS, DEPTH);
const roots = buildTree(flat);
console.log(`built: ${flat.length.toLocaleString()} folders, ${roots.length.toLocaleString()} at top level\n`);

// --- once per tree load ----------------------------------------------------
console.log("Once per tree load (not per keystroke):");
console.log(`  buildTree                    ${fmt(ms(() => buildTree(flat)))}`);
console.log(`  buildTreeIndex               ${fmt(ms(() => buildTreeIndex(flat)))}`);

const index = buildTreeIndex(flat);

// --- per keystroke ---------------------------------------------------------
// The term is one a user would actually type and that matches a lot of the
// tree, which is the expensive case: a term matching nothing exits early.
const TERM = "factures";

console.log("\nPer keystroke, typing a term that matches thousands of folders:");
const oldMs = ms(() => oldFilterTree(roots, TERM));
console.log(`  OLD  filterTree              ${fmt(oldMs)}   (re-lowercases every name, rebuilds the whole tree)`);

const newMatchMs = ms(() => matchSubjects(index, TERM));
const { matched, keep } = matchSubjects(index, TERM);
const newFlattenMs = ms(() => flattenVisible(roots, { matched, keep, filtering: true }));
const filteredRows = flattenVisible(roots, { matched, keep, filtering: true });
console.log(`  NEW  matchSubjects           ${fmt(newMatchMs)}   (pre-lowercased, set of ids, no allocation)`);
console.log(`  NEW  flattenVisible          ${fmt(newFlattenMs)}   (walks only surviving branches)`);
console.log(`  NEW  total                   ${fmt(newMatchMs + newFlattenMs)}   -> ${(oldMs / (newMatchMs + newFlattenMs)).toFixed(1)}x faster`);
console.log(`  matched ${matched.size.toLocaleString()} folders, ${keep.size.toLocaleString()} kept including ancestors`);
console.log(`  rows rendered ${filteredRows.rows.length.toLocaleString()}${filteredRows.truncated ? " (capped, and the UI says so)" : ""}`);

// --- the idle case, which is most renders ----------------------------------
console.log("\nPer render with NO search active (the common case):");
const topLevel = new Set(roots.map((r) => r.id));
const idleMs = ms(() => flattenVisible(roots, { expandedIds: topLevel, filtering: false }));
const idleRows = flattenVisible(roots, { expandedIds: topLevel, filtering: false }).rows;
console.log(`  NEW  flattenVisible          ${fmt(idleMs)}`);
console.log(`  rows produced                ${idleRows.length.toLocaleString()}  (only opened branches are walked)`);
console.log(`  OLD  React nodes mounted     ${countRenderedNodes(roots).toLocaleString()}  (every child of every open branch)`);

// --- what the DOM actually holds -------------------------------------------
const WINDOW_ROWS = 40; // roughly what fits in the pane, plus overscan
console.log("\nDOM rows held by the folder pane:");
console.log(`  OLD  every visible row       ${countRenderedNodes(roots).toLocaleString()}`);
console.log(`  NEW  windowed                ~${WINDOW_ROWS} regardless of tree size`);

/**
 * The one case where the new filter costs MORE, stated plainly rather than
 * buried.
 *
 * Typing a single letter matches most of a big tree. The old filter is fast
 * here only because it short-circuits: a matching node keeps its children by
 * reference without walking them. The new one pays to build the ancestor set
 * over 30,000 matches. Comparing those two numbers alone would say the old
 * code won -- and it would be measuring the wrong thing, because what the old
 * code did NEXT was mount a React component for every one of those nodes.
 * Filtering was never the bottleneck; rendering was.
 */
console.log("\nWorst case -- a single character, matching almost everything:");
const wideMs = ms(() => matchSubjects(index, "a"));
const wide = matchSubjects(index, "a");
const wideFlatten = ms(() => flattenVisible(roots, { matched: wide.matched, keep: wide.keep, filtering: true }));
const wideRows = flattenVisible(roots, { matched: wide.matched, keep: wide.keep, filtering: true });
const oldWide = ms(() => oldFilterTree(roots, "a"));
console.log(`  OLD  filter                  ${fmt(oldWide)}  ...then mounts ${countRenderedNodes(roots).toLocaleString()} React nodes`);
console.log(`  NEW  filter                  ${fmt(wideMs + wideFlatten)}  ...then mounts ~${WINDOW_ROWS}`);
console.log(`  matched ${wide.matched.size.toLocaleString()}, rendered ${wideRows.rows.length.toLocaleString()}${wideRows.truncated ? " (capped)" : ""}`);
console.log(`  (the cap is what makes this bounded; the input is debounced too)`);
