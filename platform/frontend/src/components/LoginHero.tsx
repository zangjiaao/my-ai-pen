import BrandLogo from "./BrandLogo";
import { BRAND_NAME, BRAND_TAGLINE } from "../lib/brand";

/** Left-panel brand hero: abstract grid / scan motion (CSS only). */
export default function LoginHero() {
  return (
    <div className="login-hero relative flex h-full min-h-[280px] flex-col justify-between overflow-hidden bg-ink px-10 py-12 text-white md:min-h-0">
      {/* Ambient layers */}
      <div className="login-hero-grid pointer-events-none absolute inset-0 opacity-[0.14]" aria-hidden />
      <div className="login-hero-scan pointer-events-none absolute inset-x-0 h-24 opacity-30" aria-hidden />
      <div className="login-hero-nodes pointer-events-none absolute inset-0" aria-hidden>
        <span className="login-node login-node-a" />
        <span className="login-node login-node-b" />
        <span className="login-node login-node-c" />
      </div>

      <div className="relative z-10 login-hero-enter">
        <BrandLogo size={36} inverted showWordmark />
        <p className="mt-8 max-w-sm text-2xl font-semibold leading-snug tracking-tight text-white">
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

      <p className="relative z-10 text-[11px] text-white/35">{BRAND_NAME} · 试点版</p>
    </div>
  );
}
