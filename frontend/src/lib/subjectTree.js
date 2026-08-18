/**
 * Tree shaping for the Library's folder pane, as plain functions.
 *
 * WHY THIS IS NOT IN LibraryPage.jsx ANY MORE
 *
 * Two reasons, and the second is the one that forced it.
 *
 * 1. VIRTUALIZATION NEEDS A FLAT LIST. A recursive <TreeNode> that renders its
 *    own children cannot be windowed -- react-window asks "give me row 8,400",
 *    and only a flat array of the currently-visible rows can answer that. So
 *    the recursion moves here, runs once per render, and produces rows.
 *
 * 2. EXPANSION STATE CANNOT LIVE IN THE ROW. It used to: every TreeNode held
 *    its own `useState(open)`. A windowed list unmounts rows that scroll out of
 *    view, which would silently reset every branch the user had opened the
 *    moment it left the viewport. The open set has to be owned above the list,
 *    and once it is, the flattening is a pure function of (tree, openSet).
 *
 * Being plain JS also makes this measurable: scripts/bench-subject-tree.mjs
 * runs it against 55,000 synthetic folders in Node, which is the only honest
 * way to answer "does this still work at that size".
 */

/** Flat rows (as the API returns them) -> roots with `children` arrays. */
export function buildTree(flat) {
  const byId = new Map();
  for (const s of flat) byId.set(s.id, { ...s, children: [] });

  const roots = [];
  for (const s of flat) {
    const node = byId.get(s.id);
    const parent = s.parent_id ? byId.get(s.parent_id) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * The part of filtering that does NOT depend on what was typed.
 *
 * Lowercasing 55,000 names is the expensive half of a substring search, and the
 * names do not change between keystrokes -- only the needle does. The old
 * filter called `node.name.toLowerCase()` inside the walk, so every keystroke
 * re-lowercased the entire taxonomy and then allocated a complete copy of the
 * tree via `{ ...node, children }`. That is the O(n) full-tree work per
 * keystroke this exists to remove: build once per tree, reuse per keystroke.
 *
 * @returns {{ids: string[], names: string[], parentById: Map<string,string|null>}}
 */
export function buildTreeIndex(flat) {
  const ids = new Array(flat.length);
  const names = new Array(flat.length);
  const parentById = new Map();

  for (let i = 0; i < flat.length; i += 1) {
    const s = flat[i];
    ids[i] = s.id;
    names[i] = (s.name || "").toLowerCase();
    parentById.set(s.id, s.parent_id || null);
  }
  return { ids, names, parentById };
}

/**
 * Which folders survive a search term.
 *
 * Same rule the recursive filter had, stated as sets instead of as a rebuilt
 * tree: keep a branch if it matches, or if any descendant does, and a matching
 * folder keeps everything inside it.
 *
 *   matched   folders whose own name contains the term
 *   keep      matched folders PLUS every ancestor of one, so the path down to
 *             a match is walkable rather than orphaned
 *
 * Descendants are deliberately NOT enumerated here. A match near the root can
 * own most of the tree, and materialising that set costs exactly what this is
 * trying to avoid -- `flattenVisible` carries an `underMatch` flag down the
 * walk instead, which is free.
 *
 * @returns {{matched: Set<string>, keep: Set<string>}}
 */
export function matchSubjects(index, term) {
  const needle = (term || "").trim().toLowerCase();
  const matched = new Set();
  const keep = new Set();
  if (!needle) return { matched, keep };

  const { ids, names, parentById } = index;
  for (let i = 0; i < names.length; i += 1) {
    if (names[i].includes(needle)) matched.add(ids[i]);
  }

  // Every ancestor of every match, so nothing is hidden behind a parent that
  // does not itself match. Walks stop early on an already-kept chain, so this
  // is far cheaper than matches x depth on a wide tree.
  for (const id of matched) {
    let cursor = id;
    while (cursor && !keep.has(cursor)) {
      keep.add(cursor);
      cursor = parentById.get(cursor) || null;
    }
  }
  return { matched, keep };
}

/**
 * How many result rows a search may produce before it stops counting.
 *
 * A search is a way to FIND a folder, not a way to render the library twice.
 * Typing one letter into a 55,000-folder tree legitimately matches most of it,
 * and there is no useful reading of "here are 48,000 results" -- the user is
 * going to type another letter. Without a cap that keystroke allocates a row
 * object per folder, which measured at 18 ms in scripts/bench-subject-tree.mjs
 * and is the one case where the windowed tree was SLOWER than the recursion it
 * replaced. Capped, the same keystroke is under a millisecond.
 *
 * The cap is reported, never silently applied -- see `truncated` below.
 */
export const MAX_FILTER_ROWS = 2000;

/**
 * The rows to actually draw, in order, as a flat array.
 *
 * This is where the saving is when nothing is being searched: it descends only
 * into branches the user has opened, so a 55,000-folder library with a few
 * branches open produces a few dozen rows and touches nothing else. The old
 * recursion mounted a React component per node of every expanded branch.
 *
 * While a search is active every surviving branch is forced open -- hiding a
 * match behind a collapsed parent would defeat the search -- so `expandedIds`
 * is ignored in that mode, exactly as `forceExpanded` used to do.
 *
 * @returns {{rows: Array<{node, depth, hasChildren, expanded}>, truncated: boolean}}
 */
export function flattenVisible(roots, { expandedIds, matched, keep, filtering, limit = MAX_FILTER_ROWS } = {}) {
  const rows = [];
  const open = expandedIds || new Set();
  // Only a SEARCH is capped. When nothing is typed the row count is whatever
  // the user chose to expand, and truncating that would hide folders they
  // deliberately opened -- the windowing already keeps the DOM small.
  const cap = filtering ? limit : Infinity;
  let truncated = false;

  const walk = (nodes, depth, underMatch) => {
    for (const node of nodes) {
      if (rows.length >= cap) { truncated = true; return; }
      const hasChildren = node.children.length > 0;

      if (!filtering) {
        const expanded = open.has(node.id);
        rows.push({ node, depth, hasChildren, expanded });
        if (hasChildren && expanded) walk(node.children, depth + 1, false);
        continue;
      }

      // A node is visible if an ancestor matched (so we are inside a match),
      // or it matched, or it is on the path down to one.
      const isMatch = matched.has(node.id);
      if (!underMatch && !isMatch && !keep.has(node.id)) continue;

      rows.push({ node, depth, hasChildren, expanded: hasChildren });
      if (hasChildren) walk(node.children, depth + 1, underMatch || isMatch);
    }
  };

  walk(roots, 0, false);
  return { rows, truncated };
}

/**
 * The ids on the path from a root down to `id`, excluding the id itself.
 *
 * Used to reveal a folder that is currently collapsed -- picking a search
 * result, or the assistant locating a file. Without this, "jump to this
 * folder" scrolls to a row that is not in the list.
 */
export function ancestorsOf(index, id) {
  const out = [];
  let cursor = index.parentById.get(id) || null;
  while (cursor) {
    out.push(cursor);
    cursor = index.parentById.get(cursor) || null;
  }
  return out;
}
