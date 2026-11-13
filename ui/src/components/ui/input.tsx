import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const field =
  'w-full min-w-0 rounded-lg border border-input bg-card px-3 shadow-xs text-sm outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-50';

export const Input = ({ className, ...p }: ComponentProps<'input'>) => <input className={cn(field, 'h-9', className)} {...p} />;
export const Textarea = ({ className, ...p }: ComponentProps<'textarea'>) => <textarea className={cn(field, 'min-h-20 py-1.5', className)} {...p} />;
export const Select = ({ className, ...p }: ComponentProps<'select'>) => <select className={cn(field, 'h-9 pr-7', className)} {...p} />;
export const Label = ({ className, ...p }: ComponentProps<'label'>) => <label className={cn('text-xs font-medium text-muted-foreground', className)} {...p} />;
