import type { SVGProps } from 'react';

/**
 * The Alba mark: a letter A whose arch holds the rising sun, resting on the horizon.
 * Geometry on a 64-unit grid; see docs/brand.md. Colors are the brand anchors, not theme tokens,
 * so the mark looks the same in light and dark (the tile carries its own night background).
 */
export const BRAND = { night: '#14183A', dusk: '#2B3170', dawn: '#F5A524', ember: '#F0785A', paper: '#FAF3E6' } as const;

export function AlbaMark({ tile = true, title = 'Alba', ...props }: SVGProps<SVGSVGElement> & { tile?: boolean; title?: string }) {
  const stroke = tile ? BRAND.paper : 'currentColor';
  return (
    <svg viewBox="0 0 64 64" role="img" aria-label={title} {...props}>
      {tile && <rect width="64" height="64" rx="15" fill={BRAND.night} />}
      {tile && <rect x="1" y="1" width="62" height="62" rx="14" fill="none" stroke={BRAND.dusk} strokeWidth="1.5" />}
      <path d="M14.5 50 L32 13.5 L49.5 50" fill="none" stroke={stroke} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 45a11 11 0 0 1 22 0z" fill={BRAND.dawn} />
      <rect x="18" y="44.5" width="28" height="3.5" rx="1.75" fill={BRAND.ember} />
    </svg>
  );
}

/** Mark plus the lower-case wordmark. The wordmark uses the interface font so it follows the theme. */
export function AlbaLogo({ className, markClassName }: { className?: string; markClassName?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <AlbaMark className={markClassName ?? 'size-7'} />
      <span className="text-[17px] font-semibold tracking-[-0.01em] lowercase leading-none">alba</span>
    </span>
  );
}
