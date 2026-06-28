import { useState } from "react";
import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";

export default function SkillPage() {
  const skills = [
    { name: "web_baseline", desc: "Web 应用基线测试", phase: "recon", tools: 6, enabled: true },
    { name: "network_baseline", desc: "主机/内网渗透基线", phase: "recon", tools: 5, enabled: true },
    { name: "sql_injection", desc: "SQL 注入检测与验证", phase: "scan", tools: 7, enabled: true },
    { name: "xss", desc: "跨站脚本检测", phase: "scan", tools: 6, enabled: true },
    { name: "auth_test", desc: "认证与授权测试", phase: "scan", tools: 7, enabled: true },
    { name: "ssrf", desc: "SSRF 检测", phase: "scan", tools: 6, enabled: true },
    { name: "idor", desc: "越权访问专项测试", phase: "scan", tools: 6, enabled: true },
    { name: "file_upload", desc: "文件上传漏洞检测", phase: "scan", tools: 7, enabled: true },
    { name: "api_test", desc: "API 安全测试", phase: "scan", tools: 7, enabled: true },
    { name: "ssti", desc: "服务端模板注入检测", phase: "scan", tools: 6, enabled: true },
  ];

  const [list, setList] = useState(skills);

  const toggle = (name: string) => setList(list.map(s => s.name === name ? { ...s, enabled: !s.enabled } : s));

  return (
    <div className="flex h-screen bg-canvas">
      <Sidebar activeId={null} onSelect={() => {}} />
      <div className="flex-1 flex-col flex">
        <TopBar title="Skill 管理" />
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mb-4 flex items-center gap-4">
            <h1 className="text-2xl font-semibold">Skill 管理</h1>
            <button className="rounded-pill bg-ink px-4 py-2 text-sm font-medium text-white">+ 上传 Skill</button>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {list.map(s => (
              <div key={s.name} className="rounded-md border border-hairline p-4">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-mono text-xs font-medium">{s.name}</span>
                  <span className={`inline-block h-2 w-2 rounded-full ${s.enabled ? "bg-status-success" : "bg-ink-muted"}`} />
                </div>
                <p className="text-sm text-ink-secondary mb-2">{s.desc}</p>
                <div className="flex items-center justify-between text-xs text-ink-muted">
                  <span>阶段: {s.phase} · 工具: {s.tools}</span>
                  <button onClick={() => toggle(s.name)} className="text-xs hover:text-ink">{s.enabled ? "禁用" : "启用"}</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
