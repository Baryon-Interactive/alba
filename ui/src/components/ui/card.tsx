import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Card = ({ className, ...p }: ComponentProps<'div'>) => (
  <div className={cn('rounded-xl border bg-card text-card-foreground shadow-[0_1px_2px_rgb(20_24_58/0.04)] dark:shadow-none', className)} {...p} />
);
export const CardHeader = ({ className, ...p }: ComponentProps<'div'>) => (
  <div className={cn('flex items-center justify-between gap-2 px-5 pt-4', className)} {...p} />
);
export const CardTitle = ({ className, ...p }: ComponentProps<'h3'>) => <h3 className={cn('text-[13.5px] font-semibold tracking-[-0.005em]', className)} {...p} />;
export const CardContent = ({ className, ...p }: ComponentProps<'div'>) => <div className={cn('px-5 py-4', className)} {...p} />;
