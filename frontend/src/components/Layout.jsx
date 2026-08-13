import { useState } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { useIdleLogout } from "../hooks/useIdleLogout";
import { AssistantProvider } from "../context/AssistantContext";
import { AssistantPanel } from "./AssistantPanel";
import { JobsDock } from "./JobsDock";

// Session timeout (spec item: users stayed logged in indefinitely). 20
// minutes of no mouse/keyboard/scroll activity signs the user out.
// Override with VITE_IDLE_TIMEOUT_MINUTES if a different window is needed.
const IDLE_TIMEOUT_MINUTES = Number(import.meta.env.VITE_IDLE_TIMEOUT_MINUTES) || 20;
const IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MINUTES * 60 * 1000;

export function Layout() {
  const { logout } = useAuth();
  const { push } = useToast();
  const navigate = useNavigate();
  // Drawer state for the sidebar below the lg breakpoint. Owned here rather
  // than in Sidebar so Topbar's hamburger can open it.
  const [navOpen, setNavOpen] = useState(false);

  useIdleLogout(
    async () => {
      await logout();
      push(`Signed out after ${IDLE_TIMEOUT_MINUTES} minutes of inactivity.`, "info");
      navigate("/login", { replace: true });
    },
    { timeoutMs: IDLE_TIMEOUT_MS }
  );

  return (
    // The assistant and the jobs dock live in the shell rather than on any
    // one page: background work is worth watching WHILE you work, and "rename
    // this file" should be answerable wherever you happen to be. Pages
    // publish what is on screen via usePublishAssistantContext.
    <AssistantProvider>
      <div className="flex h-screen w-full overflow-hidden">
        <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onOpenNav={() => setNavOpen(true)} />
          <main className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 md:px-8 md:py-8">
            <div className="mx-auto w-full max-w-7xl">
              <Outlet />
            </div>
          </main>
        </div>

        <JobsDock />
        <AssistantPanel />
      </div>
    </AssistantProvider>
  );
}
