import { useId } from 'react';

export function LobsterMark({ className = 'h-6 w-6' }: { className?: string }) {
  const reactId = useId().replace(/:/g, '');
  const shellId = `${reactId}-lobster-shell`;
  const clawId = `${reactId}-lobster-claw`;
  const circuitId = `${reactId}-lobster-circuit`;
  const glowId = `${reactId}-lobster-glow`;

  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-label="深海指挥中心"
    >
      <defs>
        <linearGradient id={shellId} x1="19" y1="15" x2="45" y2="53" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FF3B30" />
          <stop offset="0.52" stopColor="#FF7A45" />
          <stop offset="1" stopColor="#FFB340" />
        </linearGradient>
        <linearGradient id={clawId} x1="8" y1="10" x2="56" y2="24" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FF5A36" />
          <stop offset="0.56" stopColor="#FF7A45" />
          <stop offset="1" stopColor="#FFB340" />
        </linearGradient>
        <linearGradient id={circuitId} x1="19" y1="17" x2="45" y2="51" gradientUnits="userSpaceOnUse">
          <stop stopColor="#BDF4FF" />
          <stop offset="0.48" stopColor="#12D7FF" />
          <stop offset="1" stopColor="#0A84FF" />
        </linearGradient>
        <filter id={glowId} x="-16" y="-14" width="96" height="96" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="2.4" result="blur" />
          <feColorMatrix
            in="blur"
            type="matrix"
            values="0 0 0 0 1 0 0 0 0 0.36 0 0 0 0 0.13 0 0 0 0.42 0"
          />
          <feBlend in="SourceGraphic" mode="screen" />
        </filter>
      </defs>

      <path
        d="M32 10.4V54.8"
        stroke={`url(#${circuitId})`}
        strokeWidth="1.35"
        strokeDasharray="3 4"
        opacity="0.76"
      />
      <path
        d="M18.1 33.7C22.4 23.9 27.1 18.9 32 18.9C36.9 18.9 41.6 23.9 45.9 33.7C41.6 44.2 36.9 49.4 32 49.4C27.1 49.4 22.4 44.2 18.1 33.7Z"
        fill={`url(#${shellId})`}
        fillOpacity="0.18"
        stroke={`url(#${shellId})`}
        strokeWidth="3"
        filter={`url(#${glowId})`}
      />
      <path
        d="M24.4 23.9L16.8 14.4C14.8 11.9 10.9 12.9 10.3 16.1L9.2 22.8L20.8 28.2"
        stroke={`url(#${clawId})`}
        strokeWidth="3.2"
        filter={`url(#${glowId})`}
      />
      <path
        d="M39.6 23.9L47.2 14.4C49.2 11.9 53.1 12.9 53.7 16.1L54.8 22.8L43.2 28.2"
        stroke={`url(#${clawId})`}
        strokeWidth="3.2"
        filter={`url(#${glowId})`}
      />
      <path d="M22.5 34.2L12.8 39.9" stroke={`url(#${circuitId})`} strokeWidth="2.35" opacity="0.95" />
      <path d="M41.5 34.2L51.2 39.9" stroke={`url(#${circuitId})`} strokeWidth="2.35" opacity="0.95" />
      <path d="M25.3 45.8L19.1 55.3" stroke={`url(#${circuitId})`} strokeWidth="2.35" />
      <path d="M38.7 45.8L44.9 55.3" stroke={`url(#${circuitId})`} strokeWidth="2.35" />
      <path d="M27.1 28.5H36.9" stroke="#FFF6EA" strokeWidth="1.45" opacity="0.92" />
      <path d="M25.1 36.4H38.9" stroke={`url(#${circuitId})`} strokeWidth="1.45" opacity="0.86" />
      <path d="M29.2 41.7H34.8" stroke={`url(#${circuitId})`} strokeWidth="1.35" opacity="0.78" />
      <circle cx="27" cy="26.7" r="2.05" fill="#12D7FF" />
      <circle cx="37" cy="26.7" r="2.05" fill="#12D7FF" />
      <circle cx="32" cy="49.2" r="2.2" fill="#0A84FF" />
      <circle cx="9.2" cy="22.8" r="1.6" fill="#12D7FF" />
      <circle cx="54.8" cy="22.8" r="1.6" fill="#12D7FF" />
    </svg>
  );
}
