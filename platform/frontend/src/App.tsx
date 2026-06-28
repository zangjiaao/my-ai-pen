import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "./stores/authStore";
import LoginPage from "./pages/LoginPage";
import ConversationPage from "./pages/ConversationPage";

export default function App() {
  const { checkAuth, user, loading } = useAuthStore();

  useEffect(() => { checkAuth(); }, []);

  if (loading) return <div className="flex h-screen items-center justify-center text-ink-muted">Loading...</div>;

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" /> : <LoginPage />} />
      <Route path="/*" element={user ? <ConversationPage /> : <Navigate to="/login" />} />
    </Routes>
  );
}
