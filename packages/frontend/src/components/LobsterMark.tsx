export function LobsterMark({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`text-[var(--color-primary)] ${className}`}
      aria-label="深海指挥中心"
    >
      <path
        d="M14 34C18.8 24.8 25 20.2 32 20.2C39 20.2 45.2 24.8 50 34C45.2 43.2 39 47.8 32 47.8C25 47.8 18.8 43.2 14 34Z"
        fill="currentColor"
        fillOpacity={0.09}
      />
      <path d="M10 35.2C15.5 24.6 22.8 19.3 32 19.3C41.2 19.3 48.5 24.6 54 35.2" />
      <path d="M14.6 41.2C19.6 46.6 25.4 49.3 32 49.3C38.6 49.3 44.4 46.6 49.4 41.2" />
      <path d="M32 12.5V53.5" />
      <path d="M22 20.8L15.4 13.4C13.8 11.6 10.8 12.5 10.4 14.9L9.6 20.2L18.9 25.2" />
      <path d="M42 20.8L48.6 13.4C50.2 11.6 53.2 12.5 53.6 14.9L54.4 20.2L45.1 25.2" />
      <path d="M21.2 32.2C17.7 33.4 14.7 35.7 12.2 39.1" />
      <path d="M42.8 32.2C46.3 33.4 49.3 35.7 51.8 39.1" />
      <path d="M25.7 46.9L20.2 55" />
      <path d="M38.3 46.9L43.8 55" />
      <circle cx="27.8" cy="28.7" r="1.4" fill="currentColor" strokeWidth={0} />
      <circle cx="36.2" cy="28.7" r="1.4" fill="currentColor" strokeWidth={0} />
    </svg>
  );
}
