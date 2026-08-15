import { useState } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard, FileText, FolderTree, LifeBuoy, Images, Copy, Wand2,
  HardDrive, Inbox, ScrollText, Users, Boxes, Menu, X, MoreHorizontal,
  LogOut, User as UserIcon, ChevronDown, MonitorSmartphone,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { usePolling } from "../hooks/useApiData";
import { api } from "../services/apiClient";

/**
 * WHY THE NAVIGATION MOVED TO THE TOP
 *
 * The brief said to evaluate rather than assume, so: the sidebar was 256
 * fixed pixels of chrome, permanently, for eleven links. Every page in this
 * app is a wide table or a two-pane browser -- Files, Subjects, Duplicates,
 * Triage -- and on a 1366px laptop those 256px were roughly a fifth of the
 * horizontal space, spent on a list the user reads once and then navigates by
 * muscle memory. The Subjects page in particular puts a tree beside a file
 * list beside a detail panel, and it was the cramped one.
 *
 * Top navigation gives that width back to the content and costs nothing that
 * matters: the same eleven destinations still fit on one row at desktop
 * widths, and below that they collapse into a drawer exactly as the sidebar
 * already did.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * A flat row of eleven equally-weighted links is a worse menu than a sidebar,
 * not a better one. So the destinations are split by how often they are used:
 * the six that are the daily loop stay visible, and the administrative ones
 * (Audit Log, Users, Inbox, Storage, Devices) live behind a "More" menu. That
 * is a judgement about this application's actual workflow -- you look at
 * Files and Subjects constantly and at the audit log twice a year.
 */

// The daily loop. Order follows the lifecycle a document goes through, which
// is also roughly the order of how often each is opened.
const PRIMARY = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/files", label: "Files", icon: FileText },
  { to: "/subjects", label: "Subjects", icon: FolderTree },
  { to: "/triage", label: "Triage", icon: LifeBuoy, badgeKey: "triage" },
  { to: "/photos", label: "Photos", icon: Images, badgeKey: "photos" },
  { to: "/duplicates", label: "Duplicates", icon: Copy, permission: "duplicate.manage" },
];

// Reached occasionally and deliberately. Behind "More" rather than removed --
// hiding a destination entirely is how a feature stops existing.
const SECONDARY = [
  { to: "/rename-proposals", label: "Rename proposals", icon: Wand2, badgeKey: "pendingProposals" },
  { to: "/storage-locations", label: "Storage locations", icon: HardDrive },
  { to: "/devices", label: "Devices", icon: MonitorSmartphone },
  { to: "/inbox", label: "Inbox", icon: Inbox, permission: "email.manage" },
  { to: "/audit-log", label: "Audit log", icon: ScrollText, permission: "audit.view" },
  { to: "/users", label: "Users", icon: Users, permission: "user.manage" },
];

// Polled rather than fetched once so the badges reflect work that shows up
// from a scan still running in the background. 30s is frequent enough to feel
// live without hammering the API from every open tab.
const BADGE_POLL_MS = 30000;

function Badge({ count }) {
  if (!count) return null;
  return (
    <span className="ml-1 rounded-full bg-brand-500/90 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function TopNav() {
  const { user, logout, hasPermission } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  // One request for every badge. Three usePolling calls would be three timers
  // and three round trips on the same 30s beat, from every open tab.
  const { data: badgeData } = usePolling(
    () =>
      Promise.all([
        api.get("/rename-proposals/pending-count").catch(() => null),
        api.get("/triage/summary").catch(() => null),
        api.get("/photos/summary").catch(() => null),
      ]).then(([pending, triage, photos]) => ({ pending, triage, photos })),
    BADGE_POLL_MS
  );

  const badges = {
    pendingProposals: badgeData?.pending?.count || 0,
    triage: badgeData?.triage?.total || 0,
    // Only the ones actually waiting on a person -- a count that included
    // every already-read photo would sit permanently at four figures and mean
    // nothing.
    photos: (badgeData?.photos?.counts?.pending || 0) + (badgeData?.photos?.counts?.failed || 0),
  };

  const visible = (items) => items.filter((i) => !i.permission || hasPermission(i.permission));
  const primary = visible(PRIMARY);
  const secondary = visible(SECONDARY);

  return (
    <header className="sticky top-0 z-40 shrink-0 border-b border-white/5 bg-base-900/70 backdrop-blur-xl">
      <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center gap-2 px-4 sm:px-6">
        {/* Brand */}
        <NavLink to="/" className="flex shrink-0 items-center gap-2.5" aria-label="Atlas home">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-700 shadow-glow">
            <Boxes size={16} className="text-white" aria-hidden="true" />
          </div>
          <span className="hidden text-sm font-semibold text-base-50 sm:block">Atlas</span>
        </NavLink>

        {/* Primary destinations. Hidden below md, where the drawer takes over. */}
        <nav className="ml-2 hidden min-w-0 flex-1 items-center gap-0.5 md:flex" aria-label="Main">
          {primary.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? "topnav-link-active" : "topnav-link")}
            >
              <item.icon size={15} aria-hidden="true" />
              {/* The label is what makes this navigable; only drop it when
                  there genuinely is not room, which is below lg. */}
              <span className="hidden lg:inline">{item.label}</span>
              <Badge count={item.badgeKey ? badges[item.badgeKey] : 0} />
            </NavLink>
          ))}

          {secondary.length > 0 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setMoreOpen((v) => !v)}
                aria-expanded={moreOpen}
                aria-haspopup="menu"
                className="topnav-link"
              >
                <MoreHorizontal size={15} aria-hidden="true" />
                <span className="hidden lg:inline">More</span>
                <Badge count={badges.pendingProposals} />
              </button>
              {moreOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMoreOpen(false)} aria-hidden="true" />
                  <div className="glass-card animate-fade-in-up absolute left-0 z-20 mt-2 w-60 p-1.5">
                    {secondary.map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        onClick={() => setMoreOpen(false)}
                        className={({ isActive }) =>
                          "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm " +
                          (isActive ? "bg-white/[0.06] text-base-50" : "text-base-300 hover:bg-white/[0.04]")
                        }
                      >
                        <item.icon size={15} aria-hidden="true" />
                        <span className="flex-1">{item.label}</span>
                        <Badge count={item.badgeKey ? badges[item.badgeKey] : 0} />
                      </NavLink>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </nav>

        <div className="flex-1 md:hidden" />

        {/* Account */}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setAccountOpen((v) => !v)}
            aria-expanded={accountOpen}
            aria-haspopup="menu"
            className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-sm hover:bg-white/[0.05]"
          >
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-700 text-[11px] font-semibold text-white">
              {(user?.full_name || user?.email || "?").slice(0, 1).toUpperCase()}
            </div>
            <div className="hidden text-left xl:block">
              <p className="text-xs font-medium leading-tight text-base-100">{user?.full_name}</p>
              <p className="text-[10px] leading-tight text-base-400">{user?.roles?.join(", ")}</p>
            </div>
            <ChevronDown size={13} className="hidden text-base-400 xl:block" aria-hidden="true" />
          </button>

          {accountOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setAccountOpen(false)} aria-hidden="true" />
              <div className="glass-card animate-fade-in-up absolute right-0 z-20 mt-2 w-56 p-1.5">
                <div className="px-3 py-2 text-xs text-base-400">
                  <div className="flex items-center gap-1.5"><UserIcon size={12} aria-hidden="true" /> {user?.email}</div>
                </div>
                <button
                  onClick={logout}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-rose-300 hover:bg-rose-500/10"
                >
                  <LogOut size={15} aria-hidden="true" /> Sign out
                </button>
              </div>
            </>
          )}
        </div>

        {/* Drawer trigger, below md only. */}
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation menu"
          aria-controls="app-nav-drawer"
          className="rounded-xl p-2 text-base-300 hover:bg-white/[0.05] hover:text-base-100 md:hidden"
        >
          <Menu size={18} aria-hidden="true" />
        </button>
      </div>

      {/* Mobile drawer.
          Rendered only when open rather than translated off-screen: an element
          that is not in the tree cannot be tabbed into, which an off-screen
          one still can. Same reasoning the old sidebar arrived at. */}
      {drawerOpen && (
        <div className="md:hidden">
          <div
            className="fixed inset-0 z-40 bg-base-950/60 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <nav
            id="app-nav-drawer"
            className="fixed inset-y-0 right-0 z-50 flex w-72 flex-col gap-1 overflow-y-auto border-l border-white/5 bg-base-900 p-3"
            aria-label="Main"
          >
            <div className="mb-1 flex items-center justify-between px-2 py-1">
              <span className="text-sm font-semibold text-base-50">Menu</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close navigation menu"
                className="rounded-lg p-1.5 text-base-400 hover:bg-white/[0.05] hover:text-base-100"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            {[...primary, ...secondary].map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={() => setDrawerOpen(false)}
                className={({ isActive }) => (isActive ? "nav-link-active" : "nav-link")}
              >
                <item.icon size={17} aria-hidden="true" />
                <span className="flex-1">{item.label}</span>
                <Badge count={item.badgeKey ? badges[item.badgeKey] : 0} />
              </NavLink>
            ))}
          </nav>
        </div>
      )}
    </header>
  );
}
