---
name: ai-sec-platform-design
description: "A security operations console built on a monochrome canvas — white paper, black ink, one weight-graded type family, and severity colors as the only chromatic interruption. The chrome (sidebar, body, inputs, tables) stays rigorously black-and-white; the accent and severity palette earns its place by signaling risk, not decorating. Geist carries the UI voice at fine weight increments; JetBrains Mono speaks for the machine — tool output, code, severity badges. Pill-shaped CTAs, border-based surface elevation, and a confident editorial cadence inherited from Figma's design language."
version: "1.0"

colors:
  # ── Canvas & Ink (黑白骨架 — Figma 的核心设计) ──
  canvas: "#ffffff"
  canvas-inset: "#f7f7f5"
  ink: "#000000"
  ink-secondary: "#555555"
  ink-muted: "#8b8b8b"
  ink-inverse: "#ffffff"

  # ── Surfaces (灰度表面抬升 — 替代阴影) ──
  surface-default: "#f8f8f7"
  surface-elevated: "#f2f2f0"
  surface-sidebar: "#f7f7f5"

  # ── Borders ──
  hairline: "#e6e6e6"
  hairline-soft: "#f1f1f1"
  border-emphasis: "#cccccc"

  # ── Accent (单一强调色 — 类似 Figma 的 accent-magenta) ──
  accent: "#000000"
  accent-on: "#ffffff"
  accent-subtle: "#f2f2f0"

  # ── Semantic: Severity (安全等级 — 这是我们的"色块系统") ──
  severity-critical: "#d73a31"
  severity-critical-subtle: "#fef2f2"
  severity-high: "#d97706"
  severity-high-subtle: "#fffbea"
  severity-medium: "#b45309"
  severity-medium-subtle: "#fff8f0"
  severity-low: "#2563eb"
  severity-low-subtle: "#eff6ff"
  severity-info: "#6b7280"
  severity-info-subtle: "#f9fafb"

  # ── Semantic: Status ──
  status-success: "#16a34a"
  status-success-subtle: "#f0fdf4"
  status-error: "#d73a31"
  status-error-subtle: "#fef2f2"
  status-running: "#2563eb"
  status-running-subtle: "#eff6ff"

typography:
  # ── UI Sans (Geist — Figma 式的可变字重无衬线) ──
  display:
    fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: 86px
    fontWeight: 500
    lineHeight: 1.00
    letterSpacing: -1.72px
    fontFeature: kern
  display-lg:
    fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: 64px
    fontWeight: 500
    lineHeight: 1.10
    letterSpacing: -0.96px
    fontFeature: kern
  heading:
    fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: 28px
    fontWeight: 550
    lineHeight: 1.25
    letterSpacing: -0.40px
    fontFeature: kern
  subhead:
    fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: 22px
    fontWeight: 480
    lineHeight: 1.30
    letterSpacing: -0.28px
    fontFeature: kern
  body:
    fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: 16px
    fontWeight: 380
    lineHeight: 1.45
    letterSpacing: -0.12px
    fontFeature: kern
  body-sm:
    fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: 14px
    fontWeight: 380
    lineHeight: 1.45
    letterSpacing: -0.06px
    fontFeature: kern
  body-xs:
    fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: 12px
    fontWeight: 380
    lineHeight: 1.40
    letterSpacing: 0
    fontFeature: kern
  label:
    fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: 12px
    fontWeight: 520
    lineHeight: 1.30
    letterSpacing: 0.30px
    textTransform: uppercase
  button:
    fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.30
    letterSpacing: -0.08px
    fontFeature: kern

  # ── Mono (JetBrains Mono — 机器声音) ──
  code:
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', 'Menlo', monospace"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.60
    letterSpacing: 0
  code-sm:
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', 'Menlo', monospace"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 0
  eyebrow:
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', 'Menlo', monospace"
    fontSize: 12px
    fontWeight: 520
    lineHeight: 1.20
    letterSpacing: 0.54px
    textTransform: uppercase

rounded:
  none: 0
  xs: 2px
  sm: 6px
  md: 8px
  lg: 24px
  xl: 32px
  pill: 50px
  full: 9999px

spacing:
  hair: 1px
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px
  section: 96px

components:
  # ── Sidebar ──
  sidebar:
    backgroundColor: "{colors.surface-sidebar}"
    textColor: "{colors.ink}"
    width: 280px
    borderRight: "1px solid {colors.hairline}"
  sidebar-item:
    backgroundColor: transparent
    textColor: "{colors.ink-secondary}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "{spacing.xs} {spacing.sm}"
  sidebar-item-active:
    backgroundColor: "{colors.accent-subtle}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    fontWeight: 500
    rounded: "{rounded.md}"
    padding: "{spacing.xs} {spacing.sm}"
  sidebar-section-label:
    backgroundColor: transparent
    textColor: "{colors.ink-muted}"
    typography: "{typography.eyebrow}"
    padding: "{spacing.sm} {spacing.sm} {spacing.xxs}"

  # ── Top Bar ──
  topbar:
    backgroundColor: "{colors.canvas}"
    height: 56px
    borderBottom: "1px solid {colors.hairline}"
    padding: "0 {spacing.lg}"

  # ── Conversation Panel ──
  conversation-area:
    backgroundColor: "{colors.canvas}"
  conversation-message-user:
    backgroundColor: "{colors.surface-default}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "{spacing.sm} {spacing.md}"
    maxWidth: 70%
    alignSelf: flex-end
  conversation-message-agent:
    backgroundColor: transparent
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "{spacing.sm} 0"
  conversation-input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
    border: "1px solid {colors.hairline}"
    placeholderColor: "{colors.ink-muted}"

  # ── Right Panel ──
  panel-right:
    backgroundColor: "{colors.canvas}"
    width: 360px
    borderLeft: "1px solid {colors.hairline}"
  panel-tab:
    backgroundColor: transparent
    textColor: "{colors.ink-secondary}"
    typography: "{typography.body-sm}"
    padding: "{spacing.xs} {spacing.sm}"
    borderBottom: "2px solid transparent"
  panel-tab-active:
    backgroundColor: transparent
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    fontWeight: 500
    borderBottom: "2px solid {colors.ink}"

  # ── Message Cards ──
  card-tool-call:
    backgroundColor: "{colors.surface-default}"
    border: "1px solid {colors.hairline}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  card-tool-call-header:
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    fontWeight: 500
  card-tool-call-output:
    backgroundColor: "{colors.canvas-inset}"
    textColor: "{colors.ink}"
    typography: "{typography.code-sm}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm} {spacing.md}"
    border: "1px solid {colors.hairline}"

  card-vuln:
    backgroundColor: "{colors.canvas}"
    border: "1px solid {colors.hairline}"
    borderLeft: "3px solid {colors.severity-high}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  card-vuln-critical:
    borderLeft: "3px solid {colors.severity-critical}"
  card-vuln-high:
    borderLeft: "3px solid {colors.severity-high}"
  card-vuln-medium:
    borderLeft: "3px solid {colors.severity-medium}"
  card-vuln-low:
    borderLeft: "3px solid {colors.severity-low}"

  card-confirm:
    backgroundColor: "{colors.surface-elevated}"
    border: "1px solid {colors.border-emphasis}"
    rounded: "{rounded.lg}"
    padding: "{spacing.md} {spacing.lg}"

  # ── Severity Badge (Pill 形状) ──
  badge-critical:
    backgroundColor: "{colors.severity-critical-subtle}"
    textColor: "{colors.severity-critical}"
    typography: "{typography.eyebrow}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  badge-high:
    backgroundColor: "{colors.severity-high-subtle}"
    textColor: "{colors.severity-high}"
    typography: "{typography.eyebrow}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  badge-medium:
    backgroundColor: "{colors.severity-medium-subtle}"
    textColor: "{colors.severity-medium}"
    typography: "{typography.eyebrow}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  badge-low:
    backgroundColor: "{colors.severity-low-subtle}"
    textColor: "{colors.severity-low}"
    typography: "{typography.eyebrow}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  badge-info:
    backgroundColor: "{colors.severity-info-subtle}"
    textColor: "{colors.severity-info}"
    typography: "{typography.eyebrow}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"

  # ── Status ──
  status-dot:
    width: 8px
    height: 8px
    rounded: "{rounded.full}"
    display: inline-block

  # ── Buttons ──
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-on}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: "10px 24px"
  button-primary-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.accent-on}"
  button-secondary:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: "8px 22px"
    border: "1px solid {colors.hairline}"
  button-ghost:
    backgroundColor: transparent
    textColor: "{colors.ink-secondary}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "{spacing.xs} {spacing.sm}"
  button-ghost-hover:
    backgroundColor: "{colors.surface-default}"
    textColor: "{colors.ink}"
  button-danger:
    backgroundColor: "{colors.severity-critical}"
    textColor: "#ffffff"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: "10px 24px"

  # ── Data Table ──
  table:
    backgroundColor: "{colors.canvas}"
    border: "1px solid {colors.hairline-soft}"
    rounded: "{rounded.md}"
  table-header:
    backgroundColor: "{colors.surface-default}"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.label}"
    padding: "{spacing.xs} {spacing.md}"
    borderBottom: "1px solid {colors.hairline}"
  table-row:
    backgroundColor: transparent
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    padding: "{spacing.sm} {spacing.md}"
    borderBottom: "1px solid {colors.hairline-soft}"
  table-row-hover:
    backgroundColor: "{colors.surface-default}"
  table-row-selected:
    backgroundColor: "{colors.accent-subtle}"

  # ── Inputs ──
  input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
    border: "1px solid {colors.hairline}"
    placeholderColor: "{colors.ink-muted}"
  input-focus:
    border: "1px solid {colors.ink}"
    outline: "none"

  # ── Select ──
  select:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
    border: "1px solid {colors.hairline}"

  # ── Modal ──
  modal-overlay:
    backgroundColor: "rgba(0,0,0,0.40)"
  modal:
    backgroundColor: "{colors.canvas}"
    border: "1px solid {colors.hairline-soft}"
    rounded: "{rounded.xl}"
    padding: "{spacing.xl}"

  # ── Popover / Dropdown ──
  popover:
    backgroundColor: "{colors.canvas}"
    border: "1px solid {colors.hairline}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm}"

  # ── Dividers ──
  divider:
    backgroundColor: "{colors.hairline-soft}"
    height: 1px

breakpoints:
  desktop-xl: 1920px
  desktop: 1440px
  desktop-s: 1280px
  laptop: 1024px
  tablet: 768px
  mobile: 480px
---

## Overview

AI 安全运营平台的界面是一个**黑白编辑式控制台**。设计语言直接借鉴 Figma 的克制哲学：白色画布 + 黑色 ink 承载所有 UI 结构（Sidebar、对话区、表格、输入框）；语义色——安全等级和状态——是唯一被允许出现在灰度系统之外的颜色。Geist 可变字重无衬线体像 figmaSans 一样通过精细字重来表达层级，JetBrains Mono 专属于机器输出和分类标签。

### 设计原则

1. **黑白承载结构，颜色表达意义。** Sidebar、对话区、输入框、表格全部黑/白/灰。颜色只出现在漏洞等级标签、状态指示器、工具输出高亮行。颜色在这个平台上不是装饰——它是安全信号。

2. **一个字族，用字重说话。** UI 只用 Geist，通过 380/400/450/480/500/520/550 的精细字重增量建立层级——不是 regular/medium/semibold/bold 的粗糙阶梯。辅助信息的灰度只用于非关键元数据，正文永远是 `{colors.ink}` #000。

3. **等宽字体是工具的声音。** JetBrains Mono 只用于：代码块、工具输出流、命令行参数、等级标签（uppercase + positive tracking）——让用户一眼区分"这是机器在说话"和"这是界面在说话"。

4. **Pill 是唯一形状。** 按钮用 `{rounded.pill}`（50px），等级标签用 `{rounded.pill}`，状态点用 `{rounded.full}`。没有方角按钮。Pill = 可交互或可分类。

5. **不用阴影，用边框和表面抬升。** 借鉴 Figma——灰度表面变化 + 1px hairline 边框来区分层级。canvas → surface-default → surface-elevated 三步。不放 drop shadow。

6. **左边框是漏洞等级的语言。** 漏洞卡片不用整片变色，只用 3px 左边框颜色传递等级——信息密集时，左边框比整片背景色更快被视觉扫描。

---

## Colors

### Canvas & Surfaces

- **Canvas** (`{colors.canvas}` #ffffff)：页面默认背景。白纸。
- **Canvas Inset** (`{colors.canvas-inset}` #f7f7f5)：代码块背景、嵌入式数据区域——略深于 canvas 的微暖灰色。
- **Surface Default** (`{colors.surface-default}` #f8f8f7)：卡片默认背景。比 canvas 微暖半步。
- **Surface Elevated** (`{colors.surface-elevated}` #f2f2f0)：确认卡片、popover 背景。比 default 再深半步。
- **Surface Sidebar** (`{colors.surface-sidebar}` #f7f7f5)：Sidebar 背景，与 canvas 形成微妙分离。

### Ink

借鉴 Figma，不用透明度变体用确定的灰阶值。

- **Ink** (`{colors.ink}` #000000)：所有标题、正文、活跃状态文字。全文用纯黑——不用 dark-gray 冒充黑色。
- **Ink Secondary** (`{colors.ink-secondary}` #555555)：描述文字、表头、非活跃导航。只有这一种辅助灰度。
- **Ink Muted** (`{colors.ink-muted}` #8b8b8b)：placeholder、时间戳、禁用状态。
- **Ink Inverse** (`{colors.ink-inverse}` #ffffff)：在黑色 CTA 上的白色文字。

### Accent

借鉴 Figma 只用一处 `accent-magenta` 的纪律——但我们的平台用黑色本身作为 accent（pill CTA），另留一个极克制的粉色 `#ff3d8b` 用于需要跳出黑白系统的高亮时刻（如未读数气泡、促销标签）。大多数时候 accent 就是黑色。

### Semantic: Severity（我们的"色块系统"）

Figma 用 lime/lilac/cream/mint/pink 色块来区分叙事段落。我们的平台用安全等级色来标记风险——每个 severity 有一个**饱和前景色**和一个**极淡的 subtle 背景色**。

- **Critical** (`{colors.severity-critical}` #d73a31)：RCE、获取服务器权限。Subtle: #fef2f2。
- **High** (`{colors.severity-high}` #d97706)：SQL 注入、任意文件读取。Subtle: #fffbea。
- **Medium** (`{colors.severity-medium}` #b45309)：XSS、CSRF、信息泄露。Subtle: #fff8f0。
- **Low** (`{colors.severity-low}` #2563eb)：安全头缺失、版本泄露。Subtle: #eff6ff。
- **Info** (`{colors.severity-info}` #6b7280)：观察项、不确定发现。Subtle: #f9fafb。

### Semantic: Status

- **Success** (`{colors.status-success}` #16a34a)：完成、通过、已修复。Subtle: #f0fdf4。
- **Error** (`{colors.status-error}` #d73a31)：失败、阻断。Subtle: #fef2f2。
- **Running** (`{colors.status-running}` #2563eb)：执行中。Subtle: #eff6ff。

### Borders

- **Hairline** (`{colors.hairline}` #e6e6e6)：卡片、输入框、表格分隔的默认边框。
- **Hairline Soft** (`{colors.hairline-soft}` #f1f1f1)：表格行分隔、footer 分隔——几乎看不见的微妙线。
- **Border Emphasis** (`{colors.border-emphasis}` #cccccc)：确认卡片、hover 状态的强调边框。

---

## Typography

### Font Family

- **Geist** — UI 文本。Vercel 开源几何无衬线体，可变字重轴从 100 到 900。精细字重增量（380/400/450/480/500/520/550）替代传统 regular/medium/semibold 阶梯。Geist 的笔画末端微带几何切割，比 Inter 更有编辑个性，是 Figma 式"一个字族柔性表达"的等价选择。Fallback: `-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif` — 覆盖 macOS/iOS/Windows/Linux/Android 全平台。
- **JetBrains Mono** — 代码、工具输出、分类标签。开源等宽字体，在终端/IDE 中广泛使用。Fallback: `Cascadia Code, Fira Code, Consolas, Menlo, monospace` — 覆盖 Windows/macOS/Linux 全平台。

### Hierarchy

| Token | Family | Size | Weight | Line Height | Letter Spacing | Use |
|-------|--------|------|--------|-------------|----------------|-----|
| `{typography.display}` | Geist | 86px | 500 | 1.00 | -1.72px | 登录页/落地页的大标题 |
| `{typography.display-lg}` | Geist | 64px | 500 | 1.10 | -0.96px | Section 开篇标题 |
| `{typography.heading}` | Geist | 28px | 550 | 1.25 | -0.40px | 页面标题、对话标题 |
| `{typography.subhead}` | Geist | 22px | 480 | 1.30 | -0.28px | 面板 section 标题、长引导文字 |
| `{typography.body}` | Geist | 16px | 380 | 1.45 | -0.12px | 正文、对话消息、系统通知 |
| `{typography.body-sm}` | Geist | 14px | 380 | 1.45 | -0.06px | 卡片内正文、Sidebar 项 |
| `{typography.body-xs}` | Geist | 12px | 380 | 1.40 | 0 | 时间戳、元信息 |
| `{typography.label}` | Geist | 12px | 520 | 1.30 | 0.30px | 表头、输入框标签（uppercase） |
| `{typography.button}` | Geist | 18px | 500 | 1.30 | -0.08px | 所有按钮 |
| `{typography.code}` | JetBrains Mono | 14px | 400 | 1.60 | 0 | 代码块、命令 |
| `{typography.code-sm}` | JetBrains Mono | 13px | 400 | 1.55 | 0 | 工具输出流、内联代码 |
| `{typography.eyebrow}` | JetBrains Mono | 12px | 520 | 1.20 | 0.54px | 等级标签、分类标记（uppercase） |

### Principles

- **字重决定层级，不是字号。** 16px body weight 380 旁边放一个 16px label weight 520——不靠大小差异，靠粗细差异分辨信息层级。这是 Figma "body-sm at 330 next to link at 480" 的直接翻译。
- **负 letter-spacing 随字号缩放。** 86px display 拉 -1.72px；16px body 只拉 -0.12px。大的更紧，小的更松——编辑式排版的标志。
- **等宽字体只用于"机器的声音"。** `JetBrains Mono`：工具输出、命令行、代码、等级标签、CVE 编号。绝不用于 UI 说明文字。
- **行高反差。** display/heading 用紧凑行高（1.00-1.25），body 用宽松行高（1.45-1.60）。标题是图形，正文是阅读材料。

---

## Shapes

### Border Radius

| Token | Value | Use |
|-------|-------|-----|
| `{rounded.xs}` | 2px | 行内代码背景 |
| `{rounded.sm}` | 6px | 小 chip、快捷键提示 |
| `{rounded.md}` | 8px | 卡片、输入框、表格容器、图片框 |
| `{rounded.lg}` | 24px | 确认卡片、弹出卡片 |
| `{rounded.xl}` | 32px | Modal |
| `{rounded.pill}` | 50px | 所有按钮、等级标签、筛选 chip |
| `{rounded.full}` | 9999px | 状态圆点、头像、圆形图标按钮 |

### 形状纪律

- **Pill 用于交互和标识。** 按钮、等级标签、筛选 chip——pill 是"我可以按"或"我是一个归类"的视觉语言。
- **8px 圆角用于数据容器。** 卡片、输入框、代码块——`{rounded.md}` 是数据容器的统一圆角。
- **代码块不圆角。** 纯数据载体不加圆角干扰扫读。
- **状态点用正圆。** 8×8px `{rounded.full}`。

---

## Components

### Sidebar

**`sidebar`** — 微暖灰色侧栏 (`{colors.surface-sidebar}`)，宽 280px，右侧 1px `{colors.hairline}`。

- 「创建会话」黑色 pill (`button-primary`) 置顶，全宽。
- 会话列表项：默认 `{colors.ink-secondary}` weight 380；当前活跃项 `{colors.ink}` weight 500 + `{colors.accent-subtle}` 背景。
- Section 标签用 `{typography.eyebrow}` — JetBrains Mono, 12px, 520 weight, uppercase + 0.54px tracking。
- 次级导航入口（资产、漏洞、节点）放在会话列表下方，用 `divider` 隔开。
- 底部放全局状态：在线节点数 / 活跃会话数 / 待确认高危漏洞数。

### Top Bar

**`topbar`** — 56px 高，白色背景，底部 1px hairline。左侧平台 logo + 当前会话标题，右侧全局操作。

### Conversation Panel

**`conversation-message-user`** — 用户消息：`{colors.surface-default}` 微暖灰背景 + `{rounded.lg}` 圆角，右对齐，最大宽 70%。这是"人说话"。
**`conversation-message-agent`** — Agent 消息：白色背景（直接放在 canvas 上），左对齐，Markdown 渲染全宽。这是"系统说话"。
**`conversation-input`** — 底部输入框：白色 + hairline 边框 + placeholder `{colors.ink-muted}`。

### Message Cards (核心)

**`card-tool-call`** — 工具调用卡片：`{colors.surface-default}` + hairline 边框。Header 展示工具名称 (weight 500) + 状态 + 耗时。Body 用 `{colors.canvas-inset}` 背景 + `{typography.code-sm}` 展示实时输出流。

**`card-vuln`** — 漏洞卡片：白色表面 + hairline 边框 + **3px 左边框**（颜色 = 漏洞等级）。不整卡变色——左边框在列表中扫读最快。Card 内容：severity badge + 标题 + 位置 + 置信度 + 操作按钮。

**`card-confirm`** — 确认卡片：`{colors.surface-elevated}` + `{colors.border-emphasis}`。比普通卡片亮一层，让人意识到"需要我的回复"。

### Severity Badge

Pill 形状，`{typography.eyebrow}`（JetBrains Mono 12px 520 uppercase + 0.54px tracking）。每个等级一个 variant：critical (红底红字)、high (橙底橙字)、medium (棕底棕字)、low (蓝底蓝字)、info (灰底灰字)。所有 badge 使用对应的 `severity-*-subtle` 背景 + `severity-*` 前景色。

### Status Dot

`status-dot`：8px 正圆，三种颜色 — running (蓝)、success (绿)、error (红)。

### Buttons

全部 pill 形状 (`{rounded.pill}` 50px)。

- **`button-primary`**：黑色底 + 白色字。整个平台的主按钮。一个 viewport 最多一个。
- **`button-secondary`**：白色底 + 黑色字 + 1px hairline 边框。主按钮旁边的次级选项。
- **`button-ghost`**：透明底 + `{colors.ink-secondary}`。hover 变 `{colors.surface-default}` + `{colors.ink}`。
- **`button-danger`**：`{colors.severity-critical}` 红底 + 白色字。删除、终止操作。

### Data Table

**`table`**：白色背景 + `{colors.hairline-soft}` 边框 + `{rounded.md}`。
**`table-header`**：`{colors.surface-default}` + `{typography.label}` (Geist 12px 520 uppercase)。
**`table-row`**：默认透明，hover `{colors.surface-default}`，选中 `{colors.accent-subtle}`。
**`table-row-selected`**：accent-subtle 背景——选中行本身变色，不需要 checkbox 列。

### Inputs

**`input`**：白色 + 1px hairline + placeholder `{colors.ink-muted}`。
**`input-focus`**：border 变纯黑 `{colors.ink}`——不用蓝色 focus ring。白色画布上，黑色边框是最自然的 focus indicator。

### Right Panel

360px 宽，左侧 hairline 分隔。Tab 切换：默认 `{colors.ink-secondary}` weight 380，活跃 tab `{colors.ink}` weight 500 + 2px 黑色底部下划线。

### Modal

**`modal`**：白色 + `{rounded.xl}` + hairline-soft 边框。Backdrop `rgba(0,0,0,0.40)`。

---

## Elevation & Depth

不用阴影。表面抬升通过灰度+边框实现：

| Level | Surface | 使用场景 |
|-------|---------|---------|
| 0 (root) | `{colors.canvas}` #fff | 对话区、页面背景 |
| 1 (card) | `{colors.surface-default}` #f8f8f7 + 1px hairline | 工具卡片、漏洞卡片、资产卡片 |
| 2 (elevated) | `{colors.surface-elevated}` #f2f2f0 + 1px border-emphasis | 确认卡片、popover、dropdown |
| 3 (modal) | `{colors.canvas}` #fff + 1px hairline-soft | Modal 对话框 |
| 4 (backdrop) | `rgba(0,0,0,0.40)` | Modal 背后的半透明遮罩 |

---

## Responsive

### Breakpoints

| Name | Width | Key Changes |
|------|-------|-------------|
| Desktop XL | 1920px+ | 三栏全宽 |
| Desktop | 1440px | 默认设计 |
| Desktop S | 1280px | Right Panel 收缩至 320px |
| Laptop | 1024px | Right Panel 折叠为底部 Tab bar；Sidebar 收至 64px 图标模式 |
| Tablet | 768px | Sidebar → 汉堡菜单；对话区全宽；表格列简化 |
| Mobile | 480px | 单栏；卡片全宽；pill 按钮撑满宽度 |

### Collapsing

- **Sidebar**: ≥1024px 完整 280px；<1024px 收为 64px 图标栏；<768px 汉堡菜单。
- **Right Panel**: ≥1280px 完整 360px；1024-1280px 收至 280px；<1024px 底部 Tab bar。
- **对话区**: 始终 flex 占满剩余空间。

---

## Do's and Don'ts

### ✅ Do

- 正文永远用 `{colors.ink}` #000。黑色不是 harsh——是 confident。
- 用 Geist 字重差异（380/400/450/480/500/520/550）来区分信息层级——不要用灰色透明度。
- JetBrains Mono 专用于：代码、命令、工具输出、等级标签。Eyebrow 走 uppercase + positive tracking。
- 所有按钮用 `{rounded.pill}`。图标按钮用 `{rounded.full}`。
- 漏洞卡片用 **3px 左边框**（不是整张卡变色）表达等级。
- 每页最多一个 `button-primary` (黑色 pill)。出现第二个黑色按钮——把次要的改成 `button-secondary`。

### ❌ Don't

- 不要引入新的强调色。系统有 black + red/orange/brown/blue/gray severity 五色。够了。
- 不要给任何元素加 box-shadow 或 drop-shadow。表面抬升用灰度+边框。
- 不要把 JetBrains Mono 用在 UI 说明文字。它是机器声音。
- 不要用方角按钮。
- 不要在正文中使用 gray-600/700/800 作为"柔和黑色"。黑色就是 #000。
- 不要混合多个 severity 颜色在同一张卡片上。
- 不用 emoji。消息类型的视觉区分通过单色 SVG icon 或排版（字重/字族切换）完成。emoji 自带不可控的彩色，破坏黑白系统的纪律。

---

## Iteration Guide

1. 新增组件前先检查 `{colors}` 是否已有对应 token。
2. 新增颜色前问自己：表达什么**安全语义**？没有语义 → 用灰度。
3. 新增文字样式前检查能否通过 Geist weight 区分——大概率 380/400/480/500 中已有合适的。
4. 需要强调卡片 → 加左边框，不改背景色。
5. 黑色稀缺原则：一个 viewport 一个 button-primary。如果出现两个黑色按钮——降级一个。
