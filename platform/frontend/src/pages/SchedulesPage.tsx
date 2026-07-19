/**
 * Scheduled engagement tasks — table-first layout (like AssetPage),
 * create form in a modal dialog.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
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
  instruction:
    "Authorized scheduled surface check of the target. Book only proven findings with evidence.",
  engagement: "pentest",
  interval: "1d",
  node_id: "",
  goal_mode: false,
  fire_immediately: false,
};

export default function SchedulesPage() {
  const [items, setItems] = useState<Schedule[]>([]);
  const [nodes, setNodes] = useState<NodeOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState("");
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (s) =>
        s.target.toLowerCase().includes(q) ||
        s.engagement.toLowerCase().includes(q) ||
        (s.instruction || "").toLowerCase().includes(q) ||
        (s.scope || "").toLowerCase().includes(q),
    );
  }, [items, search]);

  const openCreateDialog = () => {
    setForm(EMPTY_FORM);
    setFormError("");
    setShowForm(true);
  };

  const closeCreateDialog = () => {
    if (saving) return;
    setShowForm(false);
    setFormError("");
  };

  const create = async () => {
    if (!form.target.trim() || !form.instruction.trim()) {
      setFormError("目标与指令为必填");
      return;
    }
    setSaving(true);
    setFormError("");
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
      setFormError(e instanceof Error ? e.message : "创建失败");
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
      const res = await authFetch<{ count: number }>(
        "/api/schedules/tick",
        { method: "POST" },
      );
      const n = res.count ?? 0;
      setNotice(n > 0 ? `已触发 ${n} 个到期计划（新建会话派工）` : "当前没有到期计划");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "触发失败");
    } finally {
      setTicking(false);
    }
  };

  const nodeName = (id?: string | null) => {
    if (!id) return "—";
    return nodes.find((n) => n.id === id)?.name || id.slice(0, 8);
  };

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar activeId={null} onSelect={() => {}} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar title="任务计划" />
        <div className="flex flex-1 overflow-hidden">
          <main className="flex-1 overflow-y-auto p-6">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索目标 / pack / 指令"
                className="min-w-[12rem] rounded-md border border-hairline px-3 py-2 text-sm focus:border-ink focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void runTick()}
                disabled={ticking}
                className="rounded-md border border-hairline px-4 py-2 text-sm text-ink hover:bg-canvas-inset disabled:opacity-50"
              >
                {ticking ? "检查中…" : "立即检查到期"}
              </button>
              <button
                type="button"
                onClick={openCreateDialog}
                className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-on-ink hover:opacity-90"
              >
                新建计划
              </button>
            </div>

            {error && (
              <div className="mb-4 rounded-md border border-severity-critical/30 bg-severity-critical-subtle px-4 py-3 text-sm text-severity-critical">
                {error}
              </div>
            )}
            {notice && (
              <div className="mb-4 rounded-md border border-hairline-soft bg-surface-default px-4 py-3 text-sm text-ink-secondary">
                {notice}
              </div>
            )}

            <div className="overflow-x-auto rounded-md border border-hairline-soft bg-surface-raised">
              <table className="w-full min-w-[900px] table-fixed">
                <thead>
                  <tr className="border-b border-hairline bg-surface-default text-left text-xs font-medium text-ink-secondary">
                    <th className="min-w-0 px-3 py-2.5">目标</th>
                    <th className="w-24 px-3 py-2.5">Pack</th>
                    <th className="w-24 px-3 py-2.5">周期</th>
                    <th className="w-36 px-3 py-2.5">节点</th>
                    <th className="w-40 px-3 py-2.5">下次执行</th>
                    <th className="w-40 px-3 py-2.5">上次执行</th>
                    <th className="w-20 px-3 py-2.5">状态</th>
                    <th className="w-28 px-3 py-2.5">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-10 text-center text-sm text-ink-muted">
                        加载中…
                      </td>
                    </tr>
                  ) : filtered.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-10 text-center text-sm text-ink-muted">
                        {items.length === 0
                          ? "暂无计划。点击「新建计划」创建周期复测 / 表面巡检。"
                          : "没有匹配搜索条件的计划。"}
                      </td>
                    </tr>
                  ) : (
                    filtered.map((s) => (
                      <tr
                        key={s.id}
                        className="border-b border-hairline-soft last:border-0 hover:bg-canvas-inset/50"
                      >
                        <td className="min-w-0 px-3 py-2.5">
                          <p className="truncate font-mono text-xs text-ink" title={s.target}>
                            {s.target}
                          </p>
                          {s.instruction ? (
                            <p className="mt-0.5 truncate text-[11px] text-ink-muted" title={s.instruction}>
                              {s.instruction}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-3 py-2.5 text-xs">{s.engagement}</td>
                        <td className="px-3 py-2.5 text-xs">{formatInterval(s.interval_seconds)}</td>
                        <td className="truncate px-3 py-2.5 text-xs text-ink-secondary" title={s.node_id || ""}>
                          {nodeName(s.node_id)}
                        </td>
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
                        <td className="space-x-2 px-3 py-2.5 text-xs">
                          <button
                            type="button"
                            className="text-ink-secondary hover:text-ink"
                            onClick={() => void toggleEnabled(s)}
                          >
                            {s.enabled ? "停用" : "启用"}
                          </button>
                          <button
                            type="button"
                            className="text-ink-secondary hover:text-severity-critical"
                            onClick={() => setDeleteId(s.id)}
                          >
                            删除
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </main>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(deleteId)}
        title="删除计划"
        description="确定删除该定时计划？不会删除已产生的会话或漏洞。"
        confirmLabel="删除"
        onConfirm={() => void remove()}
        onCancel={() => setDeleteId(null)}
      />

      {showForm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center theme-overlay px-4"
          onClick={closeCreateDialog}
        >
          <div
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-hairline-soft bg-canvas p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold">新建计划</h2>
            <p className="mt-1 text-xs text-ink-muted">
              按周期对已授权目标做复测 / 表面巡检，不是无人全自动挖洞。
            </p>
            <div className="mt-4 space-y-3">
              <Field label="目标 URL / 主机">
                <input
                  value={form.target}
                  onChange={(e) => setForm({ ...form, target: e.target.value })}
                  placeholder="例如 https://app.example.com"
                  className="w-full rounded-md border border-hairline px-3 py-2 font-mono text-sm focus:border-ink focus:outline-none"
                  autoFocus
                />
              </Field>
              <Field label="范围 scope（可选，默认=目标）">
                <input
                  value={form.scope}
                  onChange={(e) => setForm({ ...form, scope: e.target.value })}
                  placeholder="授权边界，可留空"
                  className="w-full rounded-md border border-hairline px-3 py-2 text-sm focus:border-ink focus:outline-none"
                />
              </Field>
              <Field label="指令 instruction">
                <textarea
                  value={form.instruction}
                  onChange={(e) => setForm({ ...form, instruction: e.target.value })}
                  rows={4}
                  className="w-full rounded-md border border-hairline px-3 py-2 text-sm focus:border-ink focus:outline-none"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="专家 pack">
                  <select
                    value={form.engagement}
                    onChange={(e) => setForm({ ...form, engagement: e.target.value })}
                    className="w-full rounded-md border border-hairline px-3 py-2 text-sm focus:border-ink focus:outline-none"
                  >
                    <option value="pentest">pentest</option>
                    <option value="ctf">ctf</option>
                  </select>
                </Field>
                <Field label="周期">
                  <select
                    value={form.interval}
                    onChange={(e) => setForm({ ...form, interval: e.target.value })}
                    className="w-full rounded-md border border-hairline px-3 py-2 text-sm focus:border-ink focus:outline-none"
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
                  value={form.node_id}
                  onChange={(e) => setForm({ ...form, node_id: e.target.value })}
                  className="w-full rounded-md border border-hairline px-3 py-2 text-sm focus:border-ink focus:outline-none"
                >
                  <option value="">（自动 / 未指定）</option>
                  {nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                      {n.status === "online" ? " · online" : ""}
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
                创建后尽快到期（仍需点「立即检查到期」）
              </label>
            </div>
            {formError && <p className="mt-3 text-xs text-severity-critical">{formError}</p>}
            <div className="mt-6 flex justify-end gap-2 border-t border-hairline-soft pt-4">
              <button
                type="button"
                disabled={saving}
                onClick={closeCreateDialog}
                className="rounded-md border border-hairline px-3 py-1.5 text-xs"
              >
                取消
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void create()}
                className="rounded-md bg-ink px-4 py-1.5 text-xs font-medium text-on-ink disabled:opacity-60"
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">{label}</span>
      {children}
    </label>
  );
}
