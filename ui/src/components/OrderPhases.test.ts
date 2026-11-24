import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PhaseBadge, PhaseStrip } from './OrderPhases';

describe('order phases', () => {
  it('labels the board card with the current phase and its position', () => {
    expect(renderToStaticMarkup(createElement(PhaseBadge, { phase: { id: 'implement', index: 2, count: 2 } }))).toContain('implement 2/2');
  });

  it('shows the planning worker, model, collapsed plan and current phase', () => {
    const html = renderToStaticMarkup(createElement(PhaseStrip, { phases: [
      { id: 'plan', mode: 'read-only', state: 'done', runs: [], worker: 'reader', model: 'compact', plan: 'Inspect the key.' },
      { id: 'implement', mode: 'write', state: 'current', runs: [] },
    ] }));
    expect(html).toContain('reader · compact');
    expect(html).toContain('aria-current="step"');
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Plan from phase plan/);
    expect(html).toContain('Inspect the key.');
  });
});
