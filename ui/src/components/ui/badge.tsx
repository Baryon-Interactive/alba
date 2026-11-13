import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap [&_svg]:size-3', {
  variants: {
    tone: {
      neutral: 'border-transparent bg-muted text-muted-foreground',
      primary: 'border-transparent bg-primary/14 text-primary',
      info: 'border-transparent bg-info/15 text-info',
      review: 'border-transparent bg-review/15 text-review',
      brand: 'border-transparent bg-brand text-brand-foreground',
      success: 'border-transparent bg-success/15 text-success',
      warning: 'border-transparent bg-warning/18 text-[color-mix(in_oklab,var(--warning)_80%,var(--foreground))]',
      danger: 'border-transparent bg-destructive/12 text-destructive',
      outline: 'text-muted-foreground',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export type Tone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

export function Badge({ className, tone, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
