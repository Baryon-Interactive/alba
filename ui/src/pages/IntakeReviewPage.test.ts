import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { setLang } from '@/i18n';
import { IntakeBlockDetail, IntakeCheckSummary, IntakeNoteForm, IntakeReviewPage, IntakeSystemBar, intakeActionBody } from './IntakeReviewPage';
import { testTranslations as translated } from '../test-translations';

vi.mock('react-router', () => ({ Link: ({ children, to }: { children: ReactNode; to: string }) => createElement('a', { href: to }, children), useParams: () => ({ tag: 'INTAKE-1' }) }));
vi.mock('@/lib/queries', () => ({ useProjectId: () => 'demo' }));
vi.mock('@/lib/api', () => ({ api: { intakeReview: async () => ({}), intakeReviewView: async () => ({}) } }));
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(),
  useQuery: (options: { queryKey: unknown[] }) => options.queryKey[0] === 'intake-review'
    ? { data: { order: 'INTAKE-1', docs: [{ id: 'core', title: 'Core', order: 1, version: 1, blocks: [{ id: 'b1', heading_path: ['Core'], text: 'The loop.', level: 1 }] }], coverage: {}, questions: '', systems: [{ id: 'RUN', status: 'pending', entities: 1, target_count: 3 }], latestCheck: { status: 'passed', tail: '3/3 blocks classified', issues: [] } }, refetch: vi.fn() }
    : { data: undefined, refetch: vi.fn() },
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

afterEach(() => setLang('en'));

it('builds action bodies with system ids', () => {
  expect(intakeActionBody('accept', 'RUN')).toEqual({ accept: ['RUN'] });
  expect(intakeActionBody('reject', 'UI', 'x')).toEqual({ reject: ['UI'], note: 'x' });
  expect(intakeActionBody('drop', 'UI', 'x')).toEqual({ drop: ['UI'], note: 'x' });
});

it('renders one system button set per system', () => {
  const html = renderToStaticMarkup(createElement(IntakeSystemBar, { systems: [{ id: 'RUN', status: 'pending', entities: 1, target_count: 3 }, { id: 'UI', status: 'pending', entities: 1, target_count: 3 }], onAction: vi.fn() }));
  expect((html.match(/data-system="RUN"/g) ?? []).length).toBe(3);
  expect((html.match(/data-system="UI"/g) ?? []).length).toBe(3);
  expect(html).toContain('Accept RUN');
  expect(html).toContain('Accept UI');
});

it('requires a note for reject and drop forms', () => {
  const empty = renderToStaticMarkup(createElement(IntakeNoteForm, { action: 'reject', system: 'UI', note: '  ', onChange: vi.fn(), onSubmit: vi.fn(), onCancel: vi.fn() }));
  const filled = renderToStaticMarkup(createElement(IntakeNoteForm, { action: 'drop', system: 'UI', note: 'x', onChange: vi.fn(), onSubmit: vi.fn(), onCancel: vi.fn() }));
  expect(empty).toMatch(/<button[^>]*\sdisabled(?:=|>)/);
  expect(filled).not.toMatch(/<button[^>]*\sdisabled(?:=|>)/);
});

it('renders every block detail classification from props', () => {
  const block = { id: 'b1', heading_path: ['Core'], text: 'Selected text.', level: 1 };
  const mapped = renderToStaticMarkup(createElement(IntakeBlockDetail, { selectedBlock: block, selectedInfo: { ref: 'core@1#b1', classification: 'mapped', entities: [{ id: 'RUN-R01', kind: 'rule', text: 'Run rule' }] } }));
  const superseded = renderToStaticMarkup(createElement(IntakeBlockDetail, { selectedBlock: block, selectedInfo: { ref: 'core@1#b1', classification: 'superseded', superseded: { ref: 'v2@1#b2', text: 'Replacement text.' } } }));
  const unclear = renderToStaticMarkup(createElement(IntakeBlockDetail, { selectedBlock: block, selectedInfo: { ref: 'core@1#b1', classification: 'unclear', gap: 'UI-G01', question: 'Which panel?' } }));
  const outOfScope = renderToStaticMarkup(createElement(IntakeBlockDetail, { selectedBlock: block, selectedInfo: { ref: 'core@1#b1', classification: 'out-of-scope', reason: 'Handled by another system.' } }));
  expect(mapped).toContain('RUN-R01'); expect(mapped).toContain('rule');
  expect(superseded).toContain('v2@1#b2'); expect(superseded).toContain('Replacement text.');
  expect(unclear).toContain('UI-G01'); expect(unclear).toContain('Which panel?');
  expect(outOfScope).toContain('Handled by another system.');
});

it('shows failed checks and limits long issue lists to ten until expanded', () => {
  const issues = Array.from({ length: 12 }, (_, index) => `issue-${index + 1}`);
  const html = renderToStaticMarkup(createElement(IntakeCheckSummary, { latestCheck: { status: 'failed', classified: 2, blocks: 3, issues } }));
  expect(html).toContain('Failed');
  expect(html).toContain('issue-10');
  expect(html.split('<details')[0]).not.toContain('issue-11');
  expect(html).toContain('Show more issues');
});

it('renders the intake review split view in English and Chinese', () => {
  const english = renderToStaticMarkup(createElement(IntakeReviewPage));
  expect(english).toContain('Intake review'); expect(english).toContain('The loop.'); expect(english).toContain('Accept'); expect(english).toContain('3/3 blocks classified');
  setLang('zh');
  const chinese = renderToStaticMarkup(createElement(IntakeReviewPage));
  expect(chinese).toContain(translated['Intake review']); expect(chinese).toContain(translated.Accept);
});
