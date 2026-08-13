import { NavLink } from "react-router-dom";
import {
  LayoutDashboard, FileText, BookCopy, FolderTree, Copy,
  Wand2, HardDrive, ScrollText, Users, Boxes, Inbox, LifeBuoy,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { usePolling } from "../hooks/useApiData";
import { api } from "../services/apiClient";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/files", label: "Files", icon: FileText },
  { to: "/documents", label: "Documents", icon: BookCopy },
  { to: "/subjects", label: "Subjects", icon: FolderTree },
  { to: "/inbox", label: "Inbox", icon: Inbox, permission: "email.manage" },
  { to: "/duplicates", label: "Duplicates", icon: Copy, permission: "duplicate.manage" },
  { to: "/rename-proposals", label: "Rename Proposals", icon: Wand2, badgeKey: "pendingProposals" },
  // Badged for the same reason as the proposal queue: a list of everything
  // the pipeline gave up on is only useful if you find out it has entries
  // without going looking for it.
  { to: "/triage", label: "Triage", icon: LifeBuoy, badgeKey: "triage" },
  // Processing Jobs is deliberately absent: background work now surfaces in
  // the floating jobs dock (components/JobsDock.jsx), which is visible from
  // every page. The /jobs route still exists for the full history and is
  // linked from the dock -- it just doesn't earn permanent nav space.
  { to: "/storage-locations", label: "Storage Locations", icon: HardDrive },
  { to: "/audit-log", label: "Audit Log", icon: ScrollText, permission: "audit.view" },
  { to: "/users", label: "Users", icon: Users, permission: "user.manage" },
];

// Polled rather than fetched once so the badges reflect proposals and
// failures that show up from a scan still running in the background -- 30s is
// frequent enough to feel live without hammering the API from every open tab.
const BADGE_POLL_MS = 30000;

/**
 * @param {object} props
 * @param {boolean} [props.open]    - drawer visibility below the lg breakpoint
 * @param {() => void} [props.onClose] - called after navigating, so the drawer
 *   closes itself rather than covering the page you just asked for
 */
export function Sidebar({ open = false, onClose }) {
  const { hasPermission } = useAuth();
  // One request for both badges: two usePolling calls would be two timers and
  // two round trips on the same 30s beat, from every open tab.
  const { data: badgeData } = usePolling(
    () =>
      Promise.all([
        api.get("/rename-proposals/pending-count").catch(() => null),
        api.get("/triage/summary").catch(() => null),
      ]).then(([pending, triage]) => ({ pending, triage })),
    BADGE_POLL_MS
  );
  const badges = {
    pendingProposals: badgeData?.pending?.count || 0,
    triage: badgeData?.triage?.total || 0,
  };

  return (
    <>
      {/* Scrim, below lg only. Tapping outside the drawer closes it, which is
          what every mobile navigation does and what people try first. */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-base-950/60 backdrop-blur-sm lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/*
        Static column from lg up; an overlay drawer below it, rendered only
        when open.

        This was `flex h-full w-64 shrink-0` with no breakpoint at all -- 256
        fixed pixels, always rendered. On a 375px-wide phone that left about
        119px for the actual application, and index.html declares a mobile
        viewport, so this was a layout the app invited people into and could
        not serve. It was also unreachable-by-design at that size: there was
        no way to dismiss it and get the space back.

        Visibility is `hidden`/`flex` rather than a translate. The first
        attempt slid the panel out with `-translate-x-full` plus
        `lg:translate-x-0`, and the two fought: the lg variant won at every
        width, so the drawer sat open on top of the page on a phone. Presence
        beats transform here -- there is no ambiguity about whether `hidden`
        applies, and an element that is not rendered cannot be tabbed into,
        which a translated-off-screen one still can.
      */}
      <aside
        id="app-sidebar"
        className={
          "z-40 h-full w-64 shrink-0 flex-col border-r border-white/5 bg-base-900/40 backdrop-blur-xl " +
          "lg:static lg:flex " +
          (open ? "fixed inset-y-0 left-0 flex" : "hidden")
        }
        aria-label="Main navigation"
      >
      <div className="flex items-center gap-2.5 px-5 py-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-700 shadow-glow">
          <Boxes size={18} className="text-white" />
        </div>
        <div>
          <p className="text-sm font-semibold leading-tight text-base-50">Atlas</p>
          <p className="text-[11px] leading-tight text-base-400">Document Intelligence</p>
        </div>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3">
        {NAV.filter((item) => !item.permission || hasPermission(item.permission)).map((item) => {
          const badgeCount = item.badgeKey ? badges[item.badgeKey] : 0;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={onClose}
              className={({ isActive }) => (isActive ? "nav-link-active" : "nav-link")}
            >
              <item.icon size={17} aria-hidden="true" />
              <span className="flex-1">{item.label}</span>
              {badgeCount > 0 && (
                <span className="rounded-full bg-brand-500/90 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                  {badgeCount > 99 ? "99+" : badgeCount}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className="border-t border-white/5 px-4 py-4">
        <p className="text-[11px] text-base-500">v0.1.0</p>
      </div>
      </aside>
    </>
  );
}
