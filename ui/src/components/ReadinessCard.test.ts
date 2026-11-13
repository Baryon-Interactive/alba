import { testTranslations as translated } from '../test-translations';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MergeReadiness } from '@api';
import { OverlapWarning, ReadinessCard } from '@/components/ReadinessCard.tsx';
import { TooltipProvider } from '@/components/ui/misc.tsx';
import { setLang } from '@/i18n';

const readiness = (patch: Partial<MergeReadiness>): MergeReadiness => ({
  project: 'demo', tag: 'A1', branch: 'demo-a1', base: 'main',
  behind: 2, ahead: 1, conflicts: false, conflictFiles: [], files: ['src/a.ts'], overlaps: [],
  computedAt: '2026-11-04T00:00:00.000Z', ...patch,
});

const html = (node: ReactNode) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(MemoryRouter, null, node)));

beforeAll(() => setLang('en'));

describe('merge readiness card', () => {
  it('shows a clean merge and links the overlapping orders', () => {
    const out = html(createElement(ReadinessCard, {
      project: 'demo',
      readiness: readiness({ overlaps: [{ tag: 'B2', files: ['src/a.ts'] }] }),
    }));
    expect(out).toContain('2 behind, 1 ahead');
    expect(out).toContain('merges cleanly');
    expect(out).toContain('text-success');
    expect(out).not.toContain('would conflict');
    expect(out).toContain('href="/p/demo/orders/B2"');
    expect(out).toContain('src/a.ts');
  });

  it('shows a conflict in red with the files', () => {
    const out = html(createElement(ReadinessCard, {
      project: 'demo',
      readiness: readiness({ conflicts: true, conflictFiles: ['src/shared.ts', 'src/twice.ts'], overlaps: [] }),
    }));
    expect(out).toContain('would conflict');
    expect(out).toContain('text-destructive');
    expect(out).toContain('src/shared.ts');
    expect(out).toContain('src/twice.ts');
    expect(out).not.toContain('merges cleanly');
    expect(out).not.toContain('href=');
  });

  it('names the overlapping orders on the board warning', () => {
    const out = html(createElement(OverlapWarning, { tags: ['B2', 'C3'] }));
    expect(out).toContain('aria-label="Overlaps B2, C3"');
    expect(out).toContain('text-warning');
    expect(html(createElement(OverlapWarning, { tags: [] }))).toBe('');
  });

  it('uses the Chinese catalog', () => {
    setLang('zh');
    try {
      const out = html(createElement(ReadinessCard, {
        project: 'demo',
        readiness: readiness({ conflicts: true, conflictFiles: ['src/shared.ts'], overlaps: [{ tag: 'B2', files: ['src/a.ts'] }] }),
      }));
      expect(out).toContain(translated['{behind} behind, {ahead} ahead'].replace('{behind}', '2').replace('{ahead}', '1'));
      expect(out).toContain(translated["would conflict"]);
      expect(out).toContain(translated["Overlaps"]);
      expect(html(createElement(OverlapWarning, { tags: ['B2'] }))).toContain('aria-label="' + translated['Overlaps {tags}'].replace('{tags}', 'B2') + '"');
    } finally {
      setLang('en');
    }
  });
});
