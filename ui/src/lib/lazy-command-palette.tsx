import { lazy, Suspense, type ComponentProps } from 'react';

const Palette = lazy(() => import('../components/CommandPalette').then(m => ({ default: m.CommandPalette })));
/** The palette's order search and cmdk are only needed after the person opens it. */
export function CommandPalette(props: ComponentProps<typeof Palette>) {
  return props.open ? <Suspense fallback={null}><Palette {...props} /></Suspense> : null;
}
