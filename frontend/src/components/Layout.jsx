import { Outlet, useNavigate } from "react-router-dom";
import { TopNav } from "./TopNav";
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
      {/*
        A column rather than a row now that navigation is horizontal. The
        sidebar it replaces owned 256 fixed pixels at every width; this gives
        that back to the content, which on this app is always a wide table or
        a multi-pane browser.

        The max width goes from 7xl (1280px) to 1600px for the same reason --
        the constraint existed to stop lines of text running too long beside a
        sidebar, and without the sidebar the tables can use the room.
      */}
      <div className="flex h-screen w-full flex-col overflow-hidden">
        <TopNav />
        <main className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 md:px-8 md:py-8">
          <div className="mx-auto w-full max-w-[1600px]">
            <Outlet />
          </div>
        </main>

        <JobsDock />
        <AssistantPanel />
      </div>
    </AssistantProvider>
  );
}
