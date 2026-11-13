import { Dialog as D } from 'radix-ui';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({ className, children, ...props }: ComponentProps<typeof D.Content>) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[1px]" />
      <D.Content
        className={cn(
          'fixed top-[12vh] left-1/2 z-50 grid max-h-[80vh] w-[min(92vw,34rem)] -translate-x-1/2 gap-3 overflow-auto rounded-xl border bg-popover p-5 text-popover-foreground shadow-2xl outline-none',
          className,
        )}
        {...props}
      >
        {children}
        <D.Close className="absolute top-3.5 right-3.5 rounded-md p-1 text-muted-foreground hover:bg-accent" aria-label="Close">
          <X className="size-4" />
        </D.Close>
      </D.Content>
    </D.Portal>
  );
}
export const DialogTitle = ({ className, ...p }: ComponentProps<typeof D.Title>) => <D.Title className={cn('pr-6 text-base font-semibold', className)} {...p} />;
export const DialogDescription = ({ className, ...p }: ComponentProps<typeof D.Description>) => (
  <D.Description className={cn('text-sm text-muted-foreground', className)} {...p} />
);
export const DialogFooter = ({ className, ...p }: ComponentProps<'div'>) => <div className={cn('mt-1 flex justify-end gap-2', className)} {...p} />;

/** A panel that slides in from the left edge: the sidebar on a narrow screen. */
export function DrawerContent({ className, children, ...props }: ComponentProps<typeof D.Content>) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/45" />
      <D.Content className={cn('fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] flex-col border-r bg-sidebar shadow-2xl outline-none', className)} {...props}>
        {children}
      </D.Content>
    </D.Portal>
  );
}
