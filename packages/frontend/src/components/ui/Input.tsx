import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const baseClass =
  'w-full rounded-md surface-1 px-3 py-2 text-[13px] text-[var(--color-fg)] placeholder:text-[var(--color-muted)] outline-none focus:border-[var(--color-primary)] focus:glow-primary ease-ocean transition-all';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(baseClass, className)} {...rest} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(baseClass, 'min-h-[80px] resize-y leading-relaxed', className)}
        {...rest}
      />
    );
  },
);

export function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <label className={cn('text-[12px] font-medium text-[var(--color-fg-muted)] mb-1.5 block', className)}>
      {children}
    </label>
  );
}
