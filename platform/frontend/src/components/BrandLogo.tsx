import { BRAND_NAME } from "../lib/brand";

type Props = {
  /** Icon edge length in px */
  size?: number;
  showWordmark?: boolean;
  /** Invert for dark backgrounds (login hero) */
  inverted?: boolean;
  className?: string;
};

/**
 * Product mark: abstract shield + node (ink / white). No third-party assets.
 */
export default function BrandLogo({
  size = 28,
  showWordmark = false,
  inverted = false,
  className = "",
}: Props) {
  const ink = inverted ? "#fafafa" : "#171717";
  const paper = inverted ? "#171717" : "#fafafa";

  return (
    <div className={`inline-flex items-center gap-2.5 ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
        className="shrink-0"
      >
        <rect width="32" height="32" rx="7" fill={ink} />
        <path
          d="M16 7.5c-3.2 0-5.8 2.1-5.8 5.2 0 2.4 1.4 4.1 3.4 5.3l-.6 4.2h6l-.6-4.2c2-1.2 3.4-2.9 3.4-5.3 0-3.1-2.6-5.2-5.8-5.2z"
          fill={paper}
        />
        <circle cx="16" cy="12.2" r="2.1" fill={ink} />
        <path d="M11 22.5h10" stroke={paper} strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      {showWordmark ? (
        <span
          className={`text-sm font-semibold tracking-tight ${
            inverted ? "text-white" : "text-ink"
          }`}
        >
          {BRAND_NAME}
        </span>
      ) : null}
    </div>
  );
}
