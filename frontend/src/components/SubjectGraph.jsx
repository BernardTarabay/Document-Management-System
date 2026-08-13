import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ZoomIn, ZoomOut, Crosshair, Minimize2 } from "lucide-react";

/**
 * Pan/zoom roadmap of the taxonomy, in the spirit of NeetCode's progression
 * tree: small pill nodes, curved connectors, depth running top to bottom,
 * and a side panel for whatever you click.
 *
 * WHAT WENT WRONG BEFORE, AND WHAT FIXES IT
 *
 * The old layout walked the tree assigning every leaf the next slot from one
 * global counter, then centred each parent over its children. Both halves of
 * that are individually reasonable and together they made expanding a branch
 * feel broken:
 *
 *   - Opening ANY node inserted new leaves into that shared counter, so every
 *     node to its right slid over and every ancestor re-centred. The root
 *     visibly jumped even though nothing about it had changed.
 *   - The viewport never moved, so the children you just revealed were
 *     frequently off screen and you had to go hunting for them.
 *
 * Three changes:
 *
 *   1. SCREEN-ANCHORED RELAYOUT. Before toggling, we record where the clicked
 *      node sits in SCREEN space; after the relayout we translate the
 *      viewport so it is still exactly there. The layout underneath is free
 *      to reflow -- the thing you were looking at does not move, which is the
 *      only part you can perceive.
 *   2. REVEAL WHAT OPENED. Having anchored, we pan by the minimum amount
 *      needed to bring the new children into view (zooming out only if they
 *      genuinely cannot fit). The screen comes to the tree; you never drag.
 *   3. STAGGERED ROWS. Siblings alternate vertically once there are more than
 *      two, so wide sibling sets stop colliding and read as branches at
 *      different depths rather than one crowded line.
 *
 * Layout is still hand-rolled rather than a graph library: this is a strict
 * three-level tree with no cross-links or cycles, far simpler than the
 * general case such a library solves.
 */

// Smaller than before -- the previous 176x48 boxes meant only a handful fit
// on screen, which is most of why the tree felt cramped and needed constant
// panning.
const NODE_WIDTH = 148;
const NODE_HEIGHT = 38;
const H_GAP = 22;
const V_GAP = 66;

// Alternating vertical offset for siblings, so a wide row of children reads
// as a staggered branch instead of a solid wall of boxes.
const STAGGER_Y = 26;
const STAGGER_FROM = 3; // only stagger once a parent has at least this many children

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 1.15;
const REVEAL_MARGIN = 56;

/**
 * Tidy top-down layout. Leaves consume horizontal slots in order and parents
 * centre over their children, which guarantees no two subtrees overlap. The
 * stagger is applied per sibling index, not globally, so it never introduces
 * a collision the packing already ruled out.
 */
function layout(nodes) {
  const positioned = [];
  let nextLeafX = 0;

  function place(node, depth, siblingIndex, siblingCount) {
    const children = node.children || [];
    const laid = children.map((c, i) => place(c, depth + 1, i, children.length));

    const x =
      laid.length === 0
        ? (() => {
            const v = nextLeafX;
            nextLeafX += NODE_WIDTH + H_GAP;
            return v;
          })()
        : (laid[0].x + laid[laid.length - 1].x) / 2;

    const stagger = siblingCount >= STAGGER_FROM && siblingIndex % 2 === 1 ? STAGGER_Y : 0;
    const entry = {
      node,
      x,
      y: depth * (NODE_HEIGHT + V_GAP) + stagger,
      depth,
      children: laid,
    };
    positioned.push(entry);
    return entry;
  }

  return { positioned, roots: nodes.map((n, i) => place(n, 0, i, nodes.length)) };
}

function edgePath(parent, child) {
  const x1 = parent.x + NODE_WIDTH / 2;
  const y1 = parent.y + NODE_HEIGHT;
  const x2 = child.x + NODE_WIDTH / 2;
  const y2 = child.y;
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

function pruneToExpanded(nodes, expanded) {
  return nodes.map((node) => ({
    ...node,
    children: expanded.has(node.id) ? pruneToExpanded(node.children || [], expanded) : [],
  }));
}

const countDescendants = (node) =>
  (node.children || []).reduce((sum, c) => sum + 1 + countDescendants(c), 0);

function findInTree(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = findInTree(node.children || [], id);
    if (hit) return hit;
  }
  return null;
}

/**
 * Every id from a root down to `id`, inclusive. Drives two things at once:
 * auto-opening the branches needed to reveal a node, and drawing the route
 * to it -- the behaviour from the NeetCode roadmap where picking a topic
 * lights up the chain of prerequisites that leads to it.
 */
function findPathIds(nodes, id, trail = []) {
  for (const node of nodes) {
    const here = [...trail, node.id];
    if (node.id === id) return here;
    const hit = findPathIds(node.children || [], id, here);
    if (hit) return hit;
  }
  return null;
}

const truncate = (t, max) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);

export function SubjectGraph({
  tree,
  selectedId,
  onSelect,
  highlight = "",
  matchedSubjectIds = null,
  onDropFile,
}) {
  const containerRef = useRef(null);
  const [expanded, setExpanded] = useState(() => new Set());
  // World coordinates map to screen by `translate(x, y) scale(k)`.
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const [dropTargetId, setDropTargetId] = useState(null);
  const panState = useRef(null);

  // The chain of subjects leading to whatever is selected. Rendered as a
  // lit route rather than just a highlighted endpoint, so "where does this
  // sit in the taxonomy" is answered by looking rather than by tracing lines
  // with a finger.
  const pathIds = useMemo(
    () => new Set(selectedId ? findPathIds(tree, selectedId) || [] : []),
    [tree, selectedId]
  );

  // Selecting something buried -- from a search result, or the assistant
  // pointing at a file -- has to OPEN the branches above it, or the route
  // leads to a node that is not on screen.
  useEffect(() => {
    if (!selectedId) return;
    const path = findPathIds(tree, selectedId);
    if (!path || path.length < 2) return;
    const ancestors = path.slice(0, -1);
    setExpanded((prev) => {
      if (ancestors.every((id) => prev.has(id))) return prev; // already open; don't churn
      const next = new Set(prev);
      for (const id of ancestors) next.add(id);
      return next;
    });
  }, [selectedId, tree]);

  const visible = useMemo(() => pruneToExpanded(tree, expanded), [tree, expanded]);
  const { positioned, roots } = useMemo(() => layout(visible), [visible]);

  // Set by toggle(), consumed by the layout effect below once the new
  // positions exist. Holds where the clicked node was on screen, so we can
  // put it back exactly there.
  const anchor = useRef(null);

  const entryById = useCallback(
    (id) => positioned.find((p) => p.node.id === id) || null,
    [positioned]
  );

  const toggle = useCallback(
    (nodeId) => {
      const entry = positioned.find((p) => p.node.id === nodeId);
      if (entry) {
        anchor.current = {
          nodeId,
          screenX: entry.x * view.k + view.x,
          screenY: entry.y * view.k + view.y,
          opening: !expanded.has(nodeId),
        };
      }
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(nodeId)) next.delete(nodeId);
        else next.add(nodeId);
        return next;
      });
    },
    [positioned, view, expanded]
  );

  const bounds = useMemo(() => {
    if (positioned.length === 0) return { minX: 0, minY: 0, width: 1, height: 1 };
    const minX = Math.min(...positioned.map((p) => p.x));
    const minY = Math.min(...positioned.map((p) => p.y));
    const maxX = Math.max(...positioned.map((p) => p.x)) + NODE_WIDTH;
    const maxY = Math.max(...positioned.map((p) => p.y)) + NODE_HEIGHT;
    return { minX, minY, width: maxX - minX, height: maxY - minY };
  }, [positioned]);

  const fitToView = useCallback(() => {
    const el = containerRef.current;
    if (!el || bounds.width <= 1) return;
    const { clientWidth: cw, clientHeight: ch } = el;
    const margin = 48;
    const k = Math.min(
      Math.min((cw - margin * 2) / bounds.width, (ch - margin * 2) / bounds.height, 1),
      MAX_ZOOM
    );
    const safeK = Math.max(k, MIN_ZOOM);
    setView({
      x: cw / 2 - (bounds.minX + bounds.width / 2) * safeK,
      y: ch / 2 - (bounds.minY + bounds.height / 2) * safeK,
      k: safeK,
    });
  }, [bounds]);

  const didInitialFit = useRef(false);
  useLayoutEffect(() => {
    if (didInitialFit.current || bounds.width <= 1) return;
    didInitialFit.current = true;
    fitToView();
  }, [bounds, fitToView]);

  /**
   * Re-pin the clicked node, then bring whatever it just revealed into view.
   *
   * Runs in a layout effect so it lands in the same frame as the new
   * positions -- in a plain effect the browser paints the reflowed tree
   * first and you see it lurch before it settles.
   */
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    anchor.current = null;

    const el = containerRef.current;
    const entry = entryById(a.nodeId);
    if (!el || !entry) return;

    setView((v) => {
      // 1. Put the clicked node back where it was on screen.
      let next = {
        k: v.k,
        x: a.screenX - entry.x * v.k,
        y: a.screenY - entry.y * v.k,
      };
      if (!a.opening || entry.children.length === 0) return next;

      // 2. Minimum pan that brings the node and its new children on screen.
      const parts = [entry, ...entry.children];
      const minX = Math.min(...parts.map((p) => p.x));
      const maxX = Math.max(...parts.map((p) => p.x)) + NODE_WIDTH;
      const minY = Math.min(...parts.map((p) => p.y));
      const maxY = Math.max(...parts.map((p) => p.y)) + NODE_HEIGHT;

      const cw = el.clientWidth;
      const ch = el.clientHeight;

      // Zoom out only if the revealed group genuinely cannot fit.
      const needK = Math.min(
        (cw - REVEAL_MARGIN * 2) / Math.max(maxX - minX, 1),
        (ch - REVEAL_MARGIN * 2) / Math.max(maxY - minY, 1)
      );
      if (needK < next.k) {
        const k = Math.max(Math.min(needK, MAX_ZOOM), MIN_ZOOM);
        // Keep the clicked node pinned while the scale changes.
        next = { k, x: a.screenX - entry.x * k, y: a.screenY - entry.y * k };
      }

      const left = minX * next.k + next.x;
      const right = maxX * next.k + next.x;
      const top = minY * next.k + next.y;
      const bottom = maxY * next.k + next.y;

      let dx = 0;
      let dy = 0;
      if (right > cw - REVEAL_MARGIN) dx = cw - REVEAL_MARGIN - right;
      if (left + dx < REVEAL_MARGIN) dx = REVEAL_MARGIN - left;
      if (bottom > ch - REVEAL_MARGIN) dy = ch - REVEAL_MARGIN - bottom;
      if (top + dy < REVEAL_MARGIN) dy = REVEAL_MARGIN - top;

      return { ...next, x: next.x + dx, y: next.y + dy };
    });
  }, [positioned, entryById]);

  // --- panning ----------------------------------------------------------
  function onPointerDown(e) {
    if (e.target.closest?.("[data-node]")) return;
    if (e.button !== 0) return;
    panState.current = { startX: e.clientX, startY: e.clientY, origin: view };
    setIsPanning(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e) {
    const pan = panState.current;
    if (!pan) return;
    setView({
      ...pan.origin,
      x: pan.origin.x + (e.clientX - pan.startX),
      y: pan.origin.y + (e.clientY - pan.startY),
    });
  }

  function endPan(e) {
    panState.current = null;
    setIsPanning(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }

  // --- zooming ----------------------------------------------------------
  const zoomAt = useCallback((screenX, screenY, factor) => {
    setView((v) => {
      const k = Math.min(Math.max(v.k * factor, MIN_ZOOM), MAX_ZOOM);
      if (k === v.k) return v;
      const worldX = (screenX - v.x) / v.k;
      const worldY = (screenY - v.y) / v.k;
      return { k, x: screenX - worldX * k, y: screenY - worldY * k };
    });
  }, []);

  // Native and non-passive so it can preventDefault the page scroll; React
  // attaches wheel listeners passively.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  function zoomFromButton(factor) {
    const el = containerRef.current;
    if (!el) return;
    zoomAt(el.clientWidth / 2, el.clientHeight / 2, factor);
  }

  const edges = useMemo(() => {
    const list = [];
    const walk = (entry) => {
      for (const child of entry.children) {
        list.push({
          key: `${entry.node.id}-${child.node.id}`,
          d: edgePath(entry, child),
          // An edge is on the route only when BOTH ends are, which is what
          // keeps a sibling branching off the path from lighting up too.
          onPath: pathIds.has(entry.node.id) && pathIds.has(child.node.id),
        });
        walk(child);
      }
    };
    roots.forEach(walk);
    return list;
  }, [roots, pathIds]);

  const needle = highlight.trim().toLowerCase();

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full overflow-hidden rounded-xl ${
        isPanning ? "cursor-grabbing" : "cursor-grab"
      }`}
      // Dot grid, as in the reference. Deliberately fixed to the container
      // rather than the drawing: a grid that pans and scales with the tree
      // turns into moire the moment you zoom out, and it is meant to be
      // texture behind the canvas, not part of it.
      style={{
        backgroundColor: "rgb(9 9 14)",
        backgroundImage: "radial-gradient(rgba(255,255,255,0.07) 1px, transparent 1px)",
        backgroundSize: "22px 22px",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerLeave={endPan}
    >
      {tree.length === 0 ? (
        <p className="p-16 text-center text-sm text-base-400">Nothing to show.</p>
      ) : (
        <svg className="absolute inset-0 h-full w-full">
          <g transform={`translate(${view.x}, ${view.y}) scale(${view.k})`}>
            {/* Route edges are drawn dotted and lit, plain edges stay a
                quiet solid grey -- the NeetCode roadmap's way of showing how
                you get to the thing you clicked. Drawn in two passes so the
                route always sits on top of the plain edges it crosses. */}
            {edges.filter((e) => !e.onPath).map((e) => (
              <path key={e.key} d={e.d} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-white/15" />
            ))}
            {edges.filter((e) => e.onPath).map((e) => (
              <path
                key={e.key}
                d={e.d}
                fill="none"
                stroke="currentColor"
                strokeWidth="2.25"
                strokeDasharray="1 6"
                strokeLinecap="round"
                className="text-brand-300"
              />
            ))}

            {positioned.map(({ node, x, y }) => {
              const hiddenChildren = countDescendants(findInTree(tree, node.id) || { children: [] });
              const hasChildren = hiddenChildren > 0;
              const isOpen = expanded.has(node.id);
              const isSelected = node.id === selectedId;
              const isMatch =
                (needle && node.name.toLowerCase().includes(needle)) ||
                (matchedSubjectIds ? matchedSubjectIds.has(node.id) : false);
              const isDropTarget = dropTargetId === node.id;
              const onPath = pathIds.has(node.id);
              const count = node.totalFileCount ?? 0;

              // Room for the toggle on the left and the count on the right.
              const labelX = hasChildren ? 26 : 12;
              const labelRoom = NODE_WIDTH - labelX - (count > 0 ? 34 : 10);
              const maxChars = Math.max(6, Math.floor(labelRoom / 6.6));

              return (
                <g
                  key={node.id}
                  data-node={node.id}
                  transform={`translate(${x}, ${y})`}
                  className="cursor-pointer"
                  onClick={() => {
                    onSelect(node);
                    if (hasChildren) toggle(node.id);
                  }}
                  onDragOver={(e) => {
                    if (!onDropFile) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDropTargetId(node.id);
                  }}
                  onDragLeave={() => setDropTargetId((id) => (id === node.id ? null : id))}
                  onDrop={(e) => {
                    if (!onDropFile) return;
                    e.preventDefault();
                    setDropTargetId(null);
                    const fileId = e.dataTransfer.getData("text/dms-file-id");
                    if (fileId) onDropFile(fileId, node);
                  }}
                >
                  {/* Solid indigo pills rather than near-transparent
                      outlines: at this size a 5%-white fill reads as empty
                      space and the tree looked like scattered text. */}
                  <rect
                    width={NODE_WIDTH}
                    height={NODE_HEIGHT}
                    rx="7"
                    className={
                      isDropTarget
                        ? "fill-emerald-500/30 stroke-emerald-400"
                        : isSelected
                          ? "fill-brand-500/60 stroke-brand-300"
                          : isMatch
                            ? "fill-amber-500/25 stroke-amber-400/70"
                            : onPath
                              ? "fill-brand-500/35 stroke-brand-400/60"
                              : "fill-brand-500/[0.18] stroke-white/10 hover:fill-brand-500/30"
                    }
                    strokeWidth={isDropTarget || isSelected ? 2 : 1.25}
                  />

                  {/* The track along the bottom edge, straight from the
                      reference. It is a TRACK, not a progress bar -- there is
                      no per-subject completion figure to fill it with, and
                      inventing one would be a chart that means nothing. It
                      exists because it is what gives these pills their shape. */}
                  <rect
                    x={10}
                    y={NODE_HEIGHT - 6}
                    width={NODE_WIDTH - 20}
                    height={2.5}
                    rx="1.25"
                    className={isSelected ? "fill-brand-200/70" : "fill-white/20"}
                  />

                  <text
                    x={labelX}
                    y={NODE_HEIGHT / 2 + 2}
                    textAnchor="start"
                    className={`pointer-events-none text-[11.5px] font-medium ${
                      isSelected ? "fill-white" : "fill-base-100"
                    }`}
                  >
                    {/* SVG has no text-overflow; truncate by hand or a long
                        name spills outside its box. */}
                    {truncate(node.name, maxChars)}
                  </text>

                  {/* The count as a quiet pill on the right, rather than a
                      second line of "12 files" text under the name -- that
                      forced every node taller, competed with the label for
                      attention, and read as content rather than metadata. */}
                  {count > 0 && (
                    <g className="pointer-events-none">
                      <rect
                        x={NODE_WIDTH - 32}
                        y={NODE_HEIGHT / 2 - 9}
                        width="24"
                        height="18"
                        rx="9"
                        className="fill-white/[0.07]"
                      />
                      <text
                        x={NODE_WIDTH - 20}
                        y={NODE_HEIGHT / 2 + 4}
                        textAnchor="middle"
                        className="fill-base-400 text-[10px] tabular-nums"
                      >
                        {count > 999 ? "999+" : count}
                      </text>
                    </g>
                  )}

                  {hasChildren && (
                    <g
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(node.id);
                      }}
                    >
                      <circle
                        cx="14"
                        cy={NODE_HEIGHT / 2}
                        r="7.5"
                        className="fill-white/[0.07] stroke-white/15"
                        strokeWidth="1"
                      />
                      {/* Plain lines, not an icon component: a lucide icon
                          renders its own <svg>, which positions
                          unpredictably inside this transformed group. */}
                      <line
                        x1="10.5"
                        y1={NODE_HEIGHT / 2}
                        x2="17.5"
                        y2={NODE_HEIGHT / 2}
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        className="pointer-events-none text-base-300"
                      />
                      {!isOpen && (
                        <line
                          x1="14"
                          y1={NODE_HEIGHT / 2 - 3.5}
                          x2="14"
                          y2={NODE_HEIGHT / 2 + 3.5}
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          className="pointer-events-none text-base-300"
                        />
                      )}
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      )}

      {/* Stacked +/- in the bottom-left corner, as in the reference, rather
          than a toolbar across the top. The top edge is where the tree's own
          root sits, and a floating bar there was covering it. */}
      <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col items-start gap-1.5">
        <div className="pointer-events-auto flex flex-col overflow-hidden rounded-lg border border-white/10 bg-base-950/80 backdrop-blur">
          <button
            className="px-2.5 py-1.5 text-base-300 transition hover:bg-white/5 hover:text-base-50"
            onClick={() => zoomFromButton(ZOOM_STEP)}
            title="Zoom in"
          >
            <ZoomIn size={14} />
          </button>
          <button
            className="border-t border-white/10 px-2.5 py-1.5 text-base-300 transition hover:bg-white/5 hover:text-base-50"
            onClick={() => zoomFromButton(1 / ZOOM_STEP)}
            title="Zoom out"
          >
            <ZoomOut size={14} />
          </button>
          <button
            className="border-t border-white/10 px-2.5 py-1.5 text-base-300 transition hover:bg-white/5 hover:text-base-50"
            onClick={fitToView}
            title="Fit the whole tree on screen"
          >
            <Crosshair size={14} />
          </button>
          {expanded.size > 0 && (
            <button
              className="border-t border-white/10 px-2.5 py-1.5 text-base-300 transition hover:bg-white/5 hover:text-base-50"
              onClick={() => setExpanded(new Set())}
              title="Collapse every branch"
            >
              <Minimize2 size={14} />
            </button>
          )}
        </div>
        <span className="pointer-events-none rounded bg-base-950/70 px-1.5 py-0.5 text-[10px] tabular-nums text-base-500 backdrop-blur">
          {Math.round(view.k * 100)}%
        </span>
      </div>
    </div>
  );
}
