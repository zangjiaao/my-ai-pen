import { useState } from "react";
import { useAuthStore } from "../stores/authStore";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const login = useAuthStore((s) => s.login);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await login(email, password);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Login failed");
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-canvas">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">AI 安全运营平台</h1>
          <p className="mt-1 text-sm text-ink-secondary">登录以继续</p>
        </div>

        {error && <div className="rounded-md bg-severity-critical-subtle px-4 py-3 text-sm text-severity-critical">{error}</div>}

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-ink-secondary">邮箱</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-hairline bg-canvas px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-muted focus:border-ink focus:outline-none"
              placeholder="admin@pentest.local"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-ink-secondary">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-hairline bg-canvas px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-muted focus:border-ink focus:outline-none"
              placeholder="••••••••"
              required
            />
          </div>
        </div>

        <button type="submit" className="w-full rounded-pill bg-ink px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90">
          登录
        </button>
      </form>
    </div>
  );
}
