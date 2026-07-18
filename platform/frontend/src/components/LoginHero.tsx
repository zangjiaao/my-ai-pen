import { BRAND_TAGLINE } from "../lib/brand";

/** Deterministic particle field — no random so SSR/hydration stay stable. */
const PARTICLES: { x: number; y: number; delay: number; duration: number; size: number }[] = [
  { x: 8, y: 14, delay: 0, duration: 9, size: 3 },
  { x: 18, y: 42, delay: 0.8, duration: 11, size: 2.5 },
  { x: 26, y: 22, delay: 1.6, duration: 8, size: 3.5 },
  { x: 34, y: 68, delay: 0.4, duration: 12, size: 2.5 },
  { x: 42, y: 12, delay: 2.1, duration: 10, size: 4 },
  { x: 48, y: 48, delay: 1.2, duration: 9, size: 3 },
  { x: 56, y: 28, delay: 2.8, duration: 11, size: 3.5 },
  { x: 62, y: 72, delay: 0.2, duration: 10, size: 2.5 },
  { x: 70, y: 18, delay: 1.9, duration: 8, size: 3 },
  { x: 76, y: 54, delay: 0.7, duration: 9, size: 3.5 },
  { x: 84, y: 36, delay: 2.4, duration: 10, size: 3 },
  { x: 12, y: 78, delay: 1.4, duration: 12, size: 2.5 },
  { x: 22, y: 58, delay: 2.6, duration: 9, size: 3.5 },
  { x: 38, y: 38, delay: 0.6, duration: 11, size: 3 },
  { x: 52, y: 82, delay: 2.5, duration: 10, size: 3.5 },
  { x: 66, y: 44, delay: 1.0, duration: 8, size: 2.5 },
  { x: 78, y: 66, delay: 2.0, duration: 9, size: 4 },
  { x: 88, y: 24, delay: 0.3, duration: 10, size: 3 },
  { x: 14, y: 32, delay: 2.2, duration: 11, size: 3.5 },
  { x: 90, y: 78, delay: 1.1, duration: 9, size: 2.5 },
  { x: 30, y: 86, delay: 1.5, duration: 12, size: 3 },
  { x: 72, y: 8, delay: 3.0, duration: 8, size: 3.5 },
  { x: 6, y: 52, delay: 0.9, duration: 10, size: 2.5 },
  { x: 44, y: 24, delay: 1.8, duration: 9, size: 3 },
  { x: 58, y: 60, delay: 0.5, duration: 11, size: 3.5 },
  { x: 82, y: 48, delay: 2.3, duration: 8, size: 3 },
  { x: 20, y: 8, delay: 1.3, duration: 10, size: 2.5 },
  { x: 94, y: 58, delay: 2.7, duration: 9, size: 3 },
];

/** Hub nodes for graph links (percent coords). */
const HUBS = [
  { id: "a", x: 28, y: 36 },
  { id: "b", x: 58, y: 48 },
  { id: "c", x: 42, y: 68 },
  { id: "d", x: 72, y: 30 },
  { id: "e", x: 64, y: 72 },
] as const;

const LINKS: [number, number][] = [
  [0, 1],
  [1, 2],
  [0, 2],
  [1, 3],
  [1, 4],
  [2, 4],
  [3, 1],
];

/** Left-panel brand hero: scan / graph / particle field (CSS only). */
export default function LoginHero() {
  return (
    <div className="login-hero relative flex h-full min-h-[280px] flex-col justify-between overflow-hidden bg-ink px-10 py-12 text-white md:min-h-0">
      {/* Ambient layers */}
      <div className="login-hero-grid pointer-events-none absolute inset-0" aria-hidden />
      <div className="login-hero-vignette pointer-events-none absolute inset-0" aria-hidden />
      <div className="login-hero-scan pointer-events-none absolute inset-x-0" aria-hidden />

      {/* Soft radar rings */}
      <div className="login-hero-radar pointer-events-none absolute" aria-hidden>
        <span className="login-radar-ring login-radar-ring-1" />
        <span className="login-radar-ring login-radar-ring-2" />
        <span className="login-radar-ring login-radar-ring-3" />
        <span className="login-radar-sweep" />
      </div>

      {/* Particle field */}
      <div className="login-hero-particles pointer-events-none absolute inset-0" aria-hidden>
        {PARTICLES.map((p, i) => (
          <span
            key={i}
            className="login-particle"
            style={{
              left: `${p.x}%`,
              top: `${p.y}%`,
              width: p.size,
              height: p.size,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.duration}s`,
            }}
          />
        ))}
      </div>

      {/* Agent / asset graph links */}
      <svg
        className="login-hero-graph pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden
        preserveAspectRatio="none"
      >
        {LINKS.map(([from, to], i) => {
          const a = HUBS[from];
          const b = HUBS[to];
          return (
            <line
              key={i}
              className="login-graph-link"
              x1={`${a.x}%`}
              y1={`${a.y}%`}
              x2={`${b.x}%`}
              y2={`${b.y}%`}
              style={{ animationDelay: `${i * 0.35}s` }}
            />
          );
        })}
      </svg>

      <div className="login-hero-nodes pointer-events-none absolute inset-0" aria-hidden>
        {HUBS.map((h, i) => (
          <span
            key={h.id}
            className={`login-node login-node-${h.id}`}
            style={{
              left: `${h.x}%`,
              top: `${h.y}%`,
              animationDelay: `${i * 0.7}s`,
            }}
          />
        ))}
      </div>

      <div className="relative z-10 login-hero-enter">
        <p className="login-hero-logo" aria-label="Cyber Security">
          <span className="login-hero-logo-cyber">Cyber</span>
          <span className="login-hero-logo-security">Security</span>
        </p>
        <p className="mt-6 max-w-sm text-2xl font-semibold leading-snug tracking-tight text-white">
          把授权测试做成可追踪的工作台
        </p>
        <p className="mt-3 max-w-sm text-sm leading-relaxed text-white/65">{BRAND_TAGLINE}</p>
      </div>

      <ul className="relative z-10 login-hero-enter-delay space-y-2 text-sm text-white/55">
        <li className="flex items-center gap-2">
          <span className="h-1 w-1 rounded-full bg-white/80" />
          Agent 会话驱动发现与取证
        </li>
        <li className="flex items-center gap-2">
          <span className="h-1 w-1 rounded-full bg-white/80" />
          漏洞台账与交付报告
        </li>
        <li className="flex items-center gap-2">
          <span className="h-1 w-1 rounded-full bg-white/80" />
          状态看板与定时巡检
        </li>
      </ul>

      <p className="relative z-10 text-[11px] text-white/35">
        <span className="font-semibold text-white/45">Cyber</span>
        <span className="font-normal"> Security</span>
        <span> · 试点版</span>
      </p>
    </div>
  );
}
