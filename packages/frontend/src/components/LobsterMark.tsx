export function LobsterMark({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`text-[var(--color-primary)] ${className}`}
      aria-label="OpenClaw"
    >
      <path d="M32 14 L32 50" />
      <path d="M22 16 Q14 8 8 14 Q12 18 22 22" />
      <path d="M42 16 Q50 8 56 14 Q52 18 42 22" />
      <path d="M20 28 Q14 32 12 38" />
      <path d="M44 28 Q50 32 52 38" />
      <ellipse cx="32" cy="32" rx="10" ry="14" />
      <path d="M28 24 L28 22" />
      <path d="M36 24 L36 22" />
      <path d="M26 44 L20 52" />
      <path d="M38 44 L44 52" />
      <path d="M32 50 L28 58 M32 50 L36 58" />
    </svg>
  );
}
