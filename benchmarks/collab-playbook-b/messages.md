# Copy-paste messages (Playbook B)

Replace `<ABS_REPO>` with your absolute path to this monorepo, e.g.  
`/mnt/d/Coding/my-ai-pen` or `D:\Coding\my-ai-pen`.

---

## Station 2 — send with expert pack **code-audit**

```text
【协作剧本B · 站2 code-audit】

上一段 pentest（模拟）已在 lab 获得 RCE，并落盘了应用源码。请只做静态代码安全评估，不要对任何主机发起攻击。

请先读取交接与源码根目录（本机路径）：
- 交接：<ABS_REPO>/benchmarks/collab-playbook-b/HANDOFF_FROM_PENTEST.md
- 源码：<ABS_REPO>/benchmarks/collab-playbook-b/source_dump/

要求：
1) skill list/load：code-repo-recon →（可选）code-partition-focus → code-focus-review → code-candidate-validate
2) 对每个候选给出 file:line、数据流、preconditions；高严重项先 validate 再 book
3) 在任务工作区写出 HANDOFF_TO_PENTEST.md（或 notes/HANDOFF_TO_PENTEST.md），列出需要动态验证的条目与建议 PoC
4) 结束后明确建议交回 application security / pentest；不要自己做动态利用

范围：仅 source_dump 内代码。
```

---

## Station 3 — send with expert pack **pentest**

```text
【协作剧本B · 站3 pentest · 回程验证】

code-audit 已完成静态分析。请消费其交接清单，不要从零全盘扫描。

请读取：
- 静态交接：优先任务工作区里的 HANDOFF_TO_PENTEST.md；若无，用聊天里 code-audit 的候选摘要
- 源码参考：<ABS_REPO>/benchmarks/collab-playbook-b/source_dump/（只读理解，非必攻）

本轮目标：
1) 对清单中每条候选给出「动态验证计划」：请求/参数/期望证据
2) 若当前没有可达 live 目标：不要扫外网；用 finding(candidate) 或笔记记录验证计划，并标注 needs_runtime / blocked_no_target
3) 若你有授权 lab HTTP 目标且 RoE 允许：只验证清单相关入口，confirm 需 evidence
4) 不要重开 nmap/全站爬虫；不要 post-ex（除非 Case 明确 redteam_deep 且本测试需要）

结束时用表格总结：候选 id | 静态位置 | 验证结果(confirm/refute/blocked) | 证据
```

---

## Optional Station 1 (skip for pure B)

Only if you want a real pentest leg first; not required for Playbook B.

```text
【可选】对授权 lab <URL> 做 redteam_deep。若获得读码能力，把源码整理到工作区并写 HANDOFF.md，然后建议切换 code-audit。
```
