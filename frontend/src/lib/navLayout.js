/**
 * Which destinations sit on the header row, and in what order.
 *
 * WHY THIS IS THE USER'S DECISION AND NOT A CONSTANT
 *
 * The split between the header row and the "More" menu was a judgement about
 * how this application is typically used -- you open Files constantly and the
 * audit log twice a year. That judgement is right on average and wrong for any
 * particular person: someone who lives in the Dashboard had it two clicks away
 * with no way to change that, and "More" stopped being an overflow menu and
 * started being a place destinations went to be forgotten.
 *
 * So the default split stays as the default, and becomes a starting point
 * rather than a rule.
 *
 * Kept as plain functions, away from the component, for the same reason the
 * subject tree is: the interesting behaviour here is what happens to a stored
 * layout when the app's own list of destinations changes underneath it, and
 * that is far easier to check directly than through a rendered header.
 */

export const NAV_LAYOUT_KEY = "atlas.navOrder";

/**
 * Resolve a stored layout against the destinations that currently exist.
 *
 * @param {object[]} all - every destination, in default order, each with `to`
 *   and an optional `defaultPrimary` flag and `permission`.
 * @param {string[]|null} pinned - the user's header order, or null if they have
 *   never rearranged it.
 * @param {(permission: string) => boolean} canSee
 *
 * THREE THINGS THIS HAS TO SURVIVE, ALL OF THEM REAL:
 *
 *  1. A destination that no longer exists. A stored layout outlives releases,
 *     and a key for a page that has been removed must be ignored rather than
 *     rendered as a dead link.
 *  2. A destination added AFTER the user customised. It cannot appear on the
 *     header uninvited -- that would silently undo their arrangement -- so it
 *     goes to More, where it is still reachable. Nothing is ever dropped
 *     entirely: a destination missing from both lists is a feature that has
 *     quietly stopped existing.
 *  3. Permissions. A layout is not an entitlement; an item the user may not see
 *     is filtered out here regardless of where they put it.
 */
export function resolveNav(all, pinned, canSee = () => true) {
  const permitted = all.filter((item) => !item.permission || canSee(item.permission));
  const byKey = new Map(permitted.map((item) => [item.to, item]));

  // No stored layout: the shipped default.
  if (!Array.isArray(pinned)) {
    return {
      primary: permitted.filter((i) => i.defaultPrimary),
      secondary: permitted.filter((i) => !i.defaultPrimary),
    };
  }

  const primary = [];
  const seen = new Set();
  for (const key of pinned) {
    const item = byKey.get(key);
    if (!item || seen.has(key)) continue; // removed destination, or a duplicate
    seen.add(key);
    primary.push(item);
  }

  // Everything else keeps its default relative order in More.
  const secondary = permitted.filter((i) => !seen.has(i.to));
  return { primary, secondary };
}

/** The header order as it stands, for writing back to storage. */
export function toStored(primary) {
  return primary.map((i) => i.to);
}

/**
 * Put `key` on the header at `index` (default: the end).
 * Moving an item that is already there is a reorder, not a duplicate.
 */
export function pinAt(pinned, key, index = null) {
  const without = pinned.filter((k) => k !== key);
  const at = index === null || index < 0 || index > without.length ? without.length : index;
  return [...without.slice(0, at), key, ...without.slice(at)];
}

/** Take `key` off the header. It falls back to More in its default position. */
export function unpin(pinned, key) {
  return pinned.filter((k) => k !== key);
}

/**
 * Drop `key` onto `targetKey`.
 *
 * `before` decides which side, which is what makes dragging feel like placing
 * rather than guessing -- the caller reads it from which half of the target the
 * pointer is over. The index is computed AFTER removing the dragged key, so
 * dragging an item rightwards lands where the gap actually opens rather than
 * one slot short.
 */
export function reorder(pinned, key, targetKey, before = true) {
  if (key === targetKey) return pinned;
  const without = pinned.filter((k) => k !== key);
  const at = without.indexOf(targetKey);
  if (at === -1) return pinAt(pinned, key);
  return pinAt(pinned, key, before ? at : at + 1);
}
