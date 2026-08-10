import { useEffect } from "react";
import { Routes, Route, Navigate, useParams } from "react-router-dom";
import { useAuthStore } from "./stores/authStore";
import LoginPage from "./pages/LoginPage";
import ConversationPage from "./pages/ConversationPage";
import DashboardPage from "./pages/DashboardPage";
import SchedulesPage from "./pages/SchedulesPage";
import AssetPage from "./pages/AssetPage";
import VulnerabilityPage from "./pages/VulnerabilityPage";
import NodePage from "./pages/NodePage";
import ExpertPage from "./pages/ExpertPage";
import AuditPage from "./pages/AuditPage";
import SonnerToast from "./components/SonnerToast";
import { casePath, isCaseId } from "./lib/caseRoutes";

/** Old `/case/:caseId` bookmarks → canonical `/:caseId`. */
function LegacyCaseRedirect() {
  const { caseId } = useParams<{ caseId: string }>();
  const id = (caseId || "").trim();
  if (isCaseId(id)) return <Navigate to={casePath(id)} replace />;
  return <Navigate to="/" replace />;
}

export default function App() {
  const { checkAuth, user, loading } = useAuthStore();

  useEffect(() => { checkAuth(); }, []);

  if (loading) return <div className="flex h-screen items-center justify-center text-ink-muted">Loading...</div>;

  return (
    <>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" /> : <LoginPage />} />
        {/* Feature routes first so they never lose to `/:caseId`. */}
        <Route path="/dashboard" element={user ? <DashboardPage /> : <Navigate to="/login" />} />
        <Route path="/assets" element={user ? <AssetPage /> : <Navigate to="/login" />} />
        <Route path="/vulnerabilities" element={user ? <VulnerabilityPage /> : <Navigate to="/login" />} />
        <Route path="/schedules" element={user ? <SchedulesPage /> : <Navigate to="/login" />} />
        <Route path="/nodes" element={user ? <NodePage /> : <Navigate to="/login" />} />
        <Route path="/experts" element={user ? <ExpertPage /> : <Navigate to="/login" />} />
        <Route path="/audit" element={user ? <AuditPage /> : <Navigate to="/login" />} />
        <Route path="/skills" element={<Navigate to="/nodes" replace />} />
        <Route path="/knowledge" element={<Navigate to="/nodes" replace />} />
        <Route path="/memories" element={<Navigate to="/nodes" replace />} />
        {/* Legacy `/case/:id` → `/:id` */}
        <Route path="/case/:caseId" element={<LegacyCaseRedirect />} />
        {/*
          One ConversationPage for blank `/` and open `/:caseId` (optional param).
          Same route element → no remount on first-message URL pin (keeps optimistic chat).
          Static feature routes above always win ranking over this dynamic segment.
        */}
        <Route
          path="/:caseId?"
          element={user ? <ConversationPage /> : <Navigate to="/login" />}
        />
      </Routes>
      {user && <SonnerToast />}
    </>
  );
}
