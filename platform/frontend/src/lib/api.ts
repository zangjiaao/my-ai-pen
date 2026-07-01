import type { TokenResponse, User, Conversation } from "./types";

const BASE = "/api";

export class ApiError extends Error {
  status: number;
  detail: unknown;

  constructor(status: number, message: string, detail: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("access_token");
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> || {}) };
  if (!(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const fullPath = path.startsWith("/api/") ? path : `${BASE}${path}`;
  const res = await fetch(fullPath, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new ApiError(res.status, err?.detail || err?.message || `HTTP ${res.status}`, err);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  login: (email: string, password: string) =>
    request<TokenResponse>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  refresh: (refreshToken: string) =>
    request<TokenResponse>("/auth/refresh", { method: "POST", body: JSON.stringify({ refresh_token: refreshToken }) }),
  me: () => request<User>("/auth/me"),
  getConversations: () => request<Conversation[]>("/conversations"),
};

// Helper for pages to use directly
export function authFetch<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  return request<T>(path, options);
}

export async function authDownload(path: string, options: RequestInit = {}): Promise<{ blob: Blob; filename: string }> {
  const token = localStorage.getItem("access_token");
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const fullPath = path.startsWith("/api/") ? path : `${BASE}${path}`;
  const res = await fetch(fullPath, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new ApiError(res.status, err?.detail || err?.message || `HTTP ${res.status}`, err);
  }
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="?([^";]+)"?/i);
  return { blob: await res.blob(), filename: match?.[1] || "report" };
}