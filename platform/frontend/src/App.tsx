import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "./stores/authStore";
import LoginPage from "./pages/LoginPage";
import ConversationPage from "./pages/ConversationPage";
import AssetPage from "./pages/AssetPage";
import VulnerabilityPage from "./pages/VulnerabilityPage";
import NodePage from "./pages/NodePage";
import AuditPage from "./pages/AuditPage";
import SonnerToast from "./components/SonnerToast";

export default function App() {
  const { checkAuth, user, loading } = useAuthStore();

  useEffect(() => { checkAuth(); }, []);

  if (loading) return <div className="flex h-screen items-center justify-center text-ink-muted">Loading...</div>;

  return (
    <>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" /> : <LoginPage />} />
        <Route path="/" element={user ? <ConversationPage /> : <Navigate to="/login" />} />
        <Route path="/assets" element={user ? <AssetPage /> : <Navigate to="/login" />} />
        <Route path="/vulnerabilities" element={user ? <VulnerabilityPage /> : <Navigate to="/login" />} />
        <Route path="/nodes" element={user ? <NodePage /> : <Navigate to="/login" />} />
        <Route path="/audit" element={user ? <AuditPage /> : <Navigate to="/login" />} />
        <Route path="/skills" element={<Navigate to="/nodes" replace />} />
        <Route path="/knowledge" element={<Navigate to="/nodes" replace />} />
        <Route path="/memories" element={<Navigate to="/nodes" replace />} />
      </Routes>
      {user && <SonnerToast />}
    </>
  );
}
