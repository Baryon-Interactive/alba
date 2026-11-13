import { Tabs as T } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Tabs = T.Root;
export const TabsList = ({ className, ...p }: ComponentProps<typeof T.List>) => <T.List className={cn('flex gap-1 overflow-x-auto shadow-[inset_0_-1px_0_var(--border)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)} {...p} />;
export const TabsTrigger = ({ className, ...p }: ComponentProps<typeof T.Trigger>) => (
  <T.Trigger
    className={cn(
      'inline-flex shrink-0 items-center whitespace-nowrap gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=active]:border-brand data-[state=active]:text-foreground',
      className,
    )}
    {...p}
  />
);
export const TabsContent = ({ className, ...p }: ComponentProps<typeof T.Content>) => <T.Content className={cn('pt-4 outline-none', className)} {...p} />;
