import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { ToastProvider } from "./context/ToastContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { Layout } from "./components/Layout";

import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { DashboardPage } from "./pages/DashboardPage";
import { FilesPage } from "./pages/FilesPage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { SubjectsPage } from "./pages/SubjectsPage";
import { DuplicateGroupsPage } from "./pages/DuplicateGroupsPage";
import { RenameProposalsPage } from "./pages/RenameProposalsPage";
import { ProcessingJobsPage } from "./pages/ProcessingJobsPage";
import { TriagePage } from "./pages/TriagePage";
import { StorageLocationsPage } from "./pages/StorageLocationsPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { UsersPage } from "./pages/UsersPage";
import { InboxPage } from "./pages/InboxPage";

function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />

          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/files" element={<FilesPage />} />
              <Route path="/documents" element={<DocumentsPage />} />
              <Route path="/subjects" element={<SubjectsPage />} />
              <Route path="/duplicates" element={<DuplicateGroupsPage />} />
              <Route path="/rename-proposals" element={<RenameProposalsPage />} />
              <Route path="/triage" element={<TriagePage />} />
              <Route path="/jobs" element={<ProcessingJobsPage />} />
              <Route path="/storage-locations" element={<StorageLocationsPage />} />
              <Route path="/audit-log" element={<AuditLogPage />} />
              <Route path="/users" element={<UsersPage />} />
              <Route path="/inbox" element={<InboxPage />} />

              {/*
                Unmatched paths land here, INSIDE the auth guard and the app
                shell. This used to be `<Route path="*" element={<DashboardPage/>}/>`
                sitting outside both: a typo'd or stale URL rendered a bare
                dashboard with no sidebar, no topbar, no way to navigate out --
                and, because it was outside ProtectedRoute, it did that for
                signed-out visitors too, showing them a broken page instead of
                sending them to the login screen.

                Redirecting rather than rendering the dashboard in place also
                means the address bar stops lying about where you are.
              */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </ToastProvider>
  );
}

export default App;
