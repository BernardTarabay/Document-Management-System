import { useState } from "react";
import { LogOut, ChevronDown, User as UserIcon, Menu } from "lucide-react";
import { useAuth } from "../context/AuthContext";

export function Topbar({ onOpenNav }) {
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="flex h-16 shrink-0 items-center justify-between border-b border-white/5 bg-base-900/30 px-4 backdrop-blur-xl sm:px-6">
      {/* The only way to reach navigation below lg, where the sidebar is a
          drawer. Above lg the sidebar is always visible and this is hidden. */}
      <button
        type="button"
        onClick={onOpenNav}
        aria-label="Open navigation menu"
        aria-controls="app-sidebar"
        className="rounded-xl p-2 text-base-300 hover:bg-white/[0.05] hover:text-base-100 lg:hidden"
      >
        <Menu size={18} />
      </button>
      <div className="hidden lg:block" />
      <div className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          className="flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-sm hover:bg-white/[0.05]"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-700 text-xs font-semibold text-white">
            {(user?.full_name || user?.email || "?").slice(0, 1).toUpperCase()}
          </div>
          {/* Name and role are the first thing worth dropping on a narrow
              screen -- the avatar still identifies the account, and the menu
              behind it repeats the email. */}
          <div className="hidden text-left sm:block">
            <p className="text-sm font-medium leading-tight text-base-100">{user?.full_name}</p>
            <p className="text-[11px] leading-tight text-base-400">{user?.roles?.join(", ")}</p>
          </div>
          <ChevronDown size={14} className="text-base-400" aria-hidden="true" />
        </button>

        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="glass-card animate-fade-in-up absolute right-0 z-20 mt-2 w-56 p-1.5">
              <div className="px-3 py-2 text-xs text-base-400">
                <div className="flex items-center gap-1.5"><UserIcon size={12} /> {user?.email}</div>
              </div>
              <button
                onClick={logout}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-rose-300 hover:bg-rose-500/10"
              >
                <LogOut size={15} /> Sign out
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
