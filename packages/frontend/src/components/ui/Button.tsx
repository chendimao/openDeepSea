import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const variants: Record<Variant, string> = {
  primary:
    'bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-[var(--color-primary-fg)] focus:glow-primary',
  secondary:
    'surface-2 hover:border-[var(--color-border-strong)] text-[var(--color-fg)]',
  ghost:
    'bg-transparent hover:bg-[var(--color-surface-raised)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]',
  danger:
    'bg-[var(--color-danger)] hover:bg-[var(--color-danger-hover)] text-white',
};

const sizes: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[12px]',
  md: 'h-9 px-3.5 text-[13px]',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }
>(function Button({ className, variant = 'primary', size = 'md', ...rest }, ref) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium ease-ocean transition-all',
        'disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-0',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    />
  );
});
