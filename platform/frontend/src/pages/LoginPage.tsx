import { useState } from "react";
import { useAuthStore } from "../stores/authStore";
import LoginHero from "../components/LoginHero";
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
    <div className="flex min-h-screen flex-col bg-canvas md:flex-row">
      {/* Left: brand / motion hero */}
      <div className="w-full md:w-[52%] lg:w-[55%]">
        <LoginHero />
      </div>

      {/* Right: form */}
      <div className="flex w-full flex-1 items-center justify-center px-6 py-12 md:w-[48%] lg:w-[45%]">
        <form
          onSubmit={handleSubmit}
          className="login-form-enter w-full max-w-sm space-y-6"
        >
          <div>
            <p className="login-form-logo mb-3 md:hidden" aria-label="Cyber Security">
              <span className="login-form-logo-cyber">Cyber</span>
              <span className="login-form-logo-security">Security</span>
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">登录</h1>
            <p className="mt-1 text-sm text-ink-secondary">进入 Cyber Security</p>
          </div>

          {error && (
            <div className="rounded-md bg-severity-critical-subtle px-4 py-3 text-sm text-severity-critical">
              {error}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-ink-secondary">
                邮箱
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-hairline bg-canvas px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-muted focus:border-ink focus:outline-none"
                placeholder="admin@pentest.local"
                required
                autoComplete="username"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-ink-secondary">
                密码
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-hairline bg-canvas px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-muted focus:border-ink focus:outline-none"
                placeholder="••••••••"
                required
                autoComplete="current-password"
              />
            </div>
          </div>

          <button
            type="submit"
            className="w-full rounded-pill bg-ink px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            登录
          </button>
        </form>
      </div>
    </div>
  );
}
