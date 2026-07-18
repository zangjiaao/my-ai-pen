/**
 * Scheduled engagement tasks — UI over /api/schedules.
 * Positioning: periodic retest / surface patrol, not unattended full pentest.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";
import { authFetch } from "../lib/api";
import ConfirmDialog from "../components/ConfirmDialog";

type Schedule = {
  id: string;
  target: string;
  scope: string;
  engagement: string;
  instruction: string;
  interval_seconds: number;
  node_id?: string | null;
  goal_mode: boolean;
  goal_objective?: string | null;
  enabled: boolean;
  next_fire_at?: string | null;
  last_fire_at?: string | null;
  last_task_id?: string | null;
  created_at: string;
};

type NodeOpt = { id: string; name: string; status?: string };

const INTERVAL_OPTIONS = [
  { value: "1h", label: "每 1 小时" },
  { value: "6h", label: "每 6 小时" },
  { value: "1d", label: "每天" },
  { value: "7d", label: "每周" },
];

function formatInterval(sec: number): string {
  if (sec >= 86400 && sec % 86400 === 0) return `${sec / 86400} 天`;
  if (sec >= 3600 && sec % 3600 === 0) return `${sec / 3600} 小时`;
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60} 分钟`;
  return `${sec} 秒`;
}

function formatWhen(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

const EMPTY_FORM = {
  target: "",
  scope: "",
  instruction: "Authorized scheduled surface check of the target. Book only proven findings with evidence.",
  engagement: "pentest",
  interval: "1d",
  node_id: "",
  goal_mode: false,
  fire_immediately: false,
};

export default function SchedulesPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Schedule[]>([]);
  const [nodes, setNodes] = useState<NodeOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [ticking, setTicking] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const list = await authFetch<Schedule[]>("/api/schedules");
      setItems(Array.isArray(list) ? list : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    (async () => {
      try {
        const list = await authFetch<NodeOpt[]>("/api/nodes");
        setNodes(Array.isArray(list) ? list : []);
      } catch {
        /* optional */
      }
    })();
  }, []);

  const create = async () => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await authFetch("/api/schedules", {
        method: "POST",
        body: JSON.stringify({
          target: form.target.trim(),
          scope: (form.scope || form.target).trim(),
          instruction: form.instruction.trim(),
          engagement: form.engagement,
          interval: form.interval,
          node_id: form.node_id || null,
          goal_mode: form.goal_mode,
          fire_immediately: form.fire_immediately,
        }),
      });
      setShowForm(false);
      setForm(EMPTY_FORM);
      setNotice("计划已创建");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (s: Schedule) => {
    setError("");
    try {
      await authFetch(`/api/schedules/${s.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新失败");
    }
  };

  const remove = async () => {
    if (!deleteId) return;
    try {
      await authFetch(`/api/schedules/${deleteId}`, { method: "DELETE" });
      setDeleteId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };

  const runTick = async () => {
    setTicking(true);
    setError("");
    setNotice("");
    try {
      const res = await authFetch<{ count: number; fired: { conversation_id?: string }[] }>(
        "/api/schedules/tick",
        { method: "POST" },
      );
      const n = res.count ?? 0;
      setNotice(n > 0 ? `已触发 ${n} 个到期计划（新建会话派工）` : "当前没有到期计划");
      await load();
      if (n > 0 && res.fired?.[0]?.conversation_id) {
        // optional: stay on page; user can open conversations
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "触发失败");
    } finally {
      setTicking(false);
    }
  };

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar activeId={null} onSelect={() => {}} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title="任务计划" />
        <main className="flex-1 overflow-y-auto p-6">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">任务计划</h1>
              <p className="mt-1 max-w-xl text-sm text-ink-secondary">
                按周期对已授权目标做复测 / 表面巡检。不是无人全自动挖洞。到期后通过「立即检查到期」或后续后台 tick 派工到会话。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void runTick()}
                disabled={ticking}
                className="rounded-pill border border-hairline px-4 py-2 text-sm text-ink hover:bg-canvas-inset disabled:opacity-50"
              >
                {ticking ? "检查中…" : "立即检查到期"}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(true)}
                className="rounded-pill bg-ink px-4 py-2 text-sm font-medium text-white hover:opacity-90"
              >
                + 新建计划
              </button>
            </div>
          </div>

          {error && (
            <div className="mb-4 rounded-md bg-severity-critical-subtle px-4 py-3 text-sm text-severity-critical">
              {error}
            </div>
          )}
          {notice && (
            <div className="mb-4 rounded-md border border-hairline bg-canvas-inset px-4 py-3 text-sm text-ink">
              {notice}
            </div>
          )}

          {showForm && (
            <div className="mb-6 max-w-xl space-y-3 rounded-lg border border-hairline p-4">
              <h2 className="text-sm font-medium">新建计划</h2>
              <Field label="目标 URL / 主机">
                <input
                  className={inputCls}
                  value={form.target}
                  onChange={(e) => setForm({ ...form, target: e.target.value })}
                  placeholder="https://app.example.com"
                />
              </Field>
              <Field label="范围 scope（默认=目标）">
                <input
                  className={inputCls}
                  value={form.scope}
                  onChange={(e) => setForm({ ...form, scope: e.target.value })}
                  placeholder="可选"
                />
              </Field>
              <Field label="指令 instruction">
                <textarea
                  className={`${inputCls} min-h-[80px]`}
                  value={form.instruction}
                  onChange={(e) => setForm({ ...form, instruction: e.target.value })}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="专家 pack">
                  <select
                    className={inputCls}
                    value={form.engagement}
                    onChange={(e) => setForm({ ...form, engagement: e.target.value })}
                  >
                    <option value="pentest">pentest</option>
                    <option value="ctf">ctf</option>
                  </select>
                </Field>
                <Field label="周期">
                  <select
                    className={inputCls}
                    value={form.interval}
                    onChange={(e) => setForm({ ...form, interval: e.target.value })}
                  >
                    {INTERVAL_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="绑定节点（可选）">
                <select
                  className={inputCls}
                  value={form.node_id}
                  onChange={(e) => setForm({ ...form, node_id: e.target.value })}
                >
                  <option value="">（自动 / 未指定）</option>
                  {nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name} {n.status === "online" ? "· online" : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="flex items-center gap-2 text-sm text-ink-secondary">
                <input
                  type="checkbox"
                  checked={form.goal_mode}
                  onChange={(e) => setForm({ ...form, goal_mode: e.target.checked })}
                />
                启用 goal mode（开放发现一般不需要）
              </label>
              <label className="flex items-center gap-2 text-sm text-ink-secondary">
                <input
                  type="checkbox"
                  checked={form.fire_immediately}
                  onChange={(e) => setForm({ ...form, fire_immediately: e.target.checked })}
                />
                创建后尽快到期（仍需点「立即检查到期」或等待 tick）
              </label>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  disabled={saving || !form.target.trim() || !form.instruction.trim()}
                  onClick={() => void create()}
                  className="rounded-pill bg-ink px-4 py-2 text-sm text-white disabled:opacity-50"
                >
                  {saving ? "保存中…" : "创建"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="rounded-pill border border-hairline px-4 py-2 text-sm"
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {loading ? (
            <p className="text-sm text-ink-muted">加载中…</p>
          ) : items.length === 0 ? (
            <p className="py-12 text-center text-sm text-ink-muted">
              暂无计划。创建后可定期对授权目标做巡检。
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-hairline">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-hairline bg-canvas-inset text-[11px] font-medium uppercase tracking-wider text-ink-muted">
                  <tr>
                    <th className="px-3 py-2">目标</th>
                    <th className="px-3 py-2">Pack</th>
                    <th className="px-3 py-2">周期</th>
                    <th className="px-3 py-2">下次</th>
                    <th className="px-3 py-2">上次</th>
                    <th className="px-3 py-2">状态</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline-soft">
                  {items.map((s) => (
                    <tr key={s.id} className="hover:bg-canvas-inset/60">
                      <td className="max-w-[200px] truncate px-3 py-2.5 font-mono text-xs">{s.target}</td>
                      <td className="px-3 py-2.5 text-xs">{s.engagement}</td>
                      <td className="px-3 py-2.5 text-xs">{formatInterval(s.interval_seconds)}</td>
                      <td className="px-3 py-2.5 text-xs text-ink-secondary">{formatWhen(s.next_fire_at)}</td>
                      <td className="px-3 py-2.5 text-xs text-ink-secondary">{formatWhen(s.last_fire_at)}</td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            s.enabled
                              ? "bg-status-success/15 text-status-success"
                              : "bg-canvas-inset text-ink-muted"
                          }`}
                        >
                          {s.enabled ? "启用" : "停用"}
                        </span>
                      </td>
                      <td className="space-x-2 px-3 py-2.5 text-right text-xs">
                        <button type="button" className="text-ink-secondary hover:text-ink" onClick={() => void toggleEnabled(s)}>
                          {s.enabled ? "停用" : "启用"}
                        </button>
                        <button type="button" className="text-ink-secondary hover:text-ink" onClick={() => setDeleteId(s.id)}>
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-6 text-xs text-ink-muted">
            提示：当前到期触发依赖「立即检查到期」或后续平台后台 tick。派工会创建新会话；请确保 Node 在线且专家包已安装。
          </p>
          <button type="button" onClick={() => navigate("/")} className="mt-3 text-sm text-ink-secondary hover:text-ink">
            ← 回到会话
          </button>
        </main>
      </div>

      <ConfirmDialog
        open={Boolean(deleteId)}
        title="删除计划"
        description="确定删除该定时计划？不会删除已产生的会话或漏洞。"
        confirmLabel="删除"
        onConfirm={() => void remove()}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-ink focus:outline-none";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">{label}</span>
      {children}
    </label>
  );
}
