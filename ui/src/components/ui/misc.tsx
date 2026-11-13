import { Checkbox as C, Tooltip as T, DropdownMenu as M } from 'radix-ui';
import { Check } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Checkbox({ className, ...p }: ComponentProps<typeof C.Root>) {
  return (
    <C.Root
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input bg-card data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        className,
      )}
      {...p}
    >
      <C.Indicator>
        <Check className="size-3" />
      </C.Indicator>
    </C.Root>
  );
}

export const TooltipProvider = T.Provider;
export function Tip({ text, children }: { text?: string; children: ReactNode }) {
  if (!text) return <>{children}</>;
  return (
    <T.Root delayDuration={250}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content sideOffset={4} className="z-[60] max-w-xs rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md">
          {text}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;
export const MenuContent = ({ className, ...p }: ComponentProps<typeof M.Content>) => (
  <M.Portal>
    <M.Content sideOffset={4} className={cn('z-50 min-w-48 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg', className)} {...p} />
  </M.Portal>
);
export const MenuItem = ({ className, ...p }: ComponentProps<typeof M.Item>) => (
  <M.Item className={cn('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent', className)} {...p} />
);
export const MenuLabel = ({ className, ...p }: ComponentProps<typeof M.Label>) => <M.Label className={cn('px-2 py-1 text-xs text-muted-foreground', className)} {...p} />;

export function Progress({ value, className, tone }: { value: number; className?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'bad' ? 'bg-destructive' : tone === 'warn' ? 'bg-warning' : 'bg-primary';
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}>
      <div className={cn('h-full rounded-full transition-[width]', color)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export const Skeleton = ({ className }: { className?: string }) => <div className={cn('shimmer rounded-md', className)} />;
