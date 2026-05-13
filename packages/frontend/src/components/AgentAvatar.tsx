import { cn } from '../lib/utils';

const PALETTE = ['#FF6B47', '#22D3EE', '#10B981', '#F59E0B', '#A78BFA', '#F472B6', '#34D399'];

function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}

export function AgentAvatar({
  name,
  size = 32,
  active,
  className,
}: {
  name: string;
  size?: number;
  active?: boolean;
  className?: string;
}) {
  const initial = (name || '?').slice(0, 2).toUpperCase();
  const color = colorFor(name);
  return (
    <div
      className={cn('relative flex-shrink-0', className)}
      style={{ width: size, height: size }}
      aria-label={name}
    >
      <div
        className={cn(
          'h-full w-full rounded-full flex items-center justify-center font-display font-semibold text-white',
          active && 'heartbeat',
        )}
        style={{
          background: `linear-gradient(135deg, ${color}, ${color}99)`,
          fontSize: Math.floor(size * 0.4),
        }}
      >
        {initial}
      </div>
      {active && (
        <span
          className="absolute -right-0.5 -bottom-0.5 block h-2.5 w-2.5 rounded-full border-2 border-[var(--color-bg)]"
          style={{ background: 'var(--color-success)' }}
        />
      )}
    </div>
  );
}
