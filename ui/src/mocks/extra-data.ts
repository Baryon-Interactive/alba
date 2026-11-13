// Made-up decisions and lessons for the mock server (a neutral demo project).
import type { DecisionEntry, Lesson } from '@api';

const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString();

export function mockDecisions(): DecisionEntry[] {
  const d = (number: number, ago: number, text: string, source: string, sourceKind: DecisionEntry['sourceKind'] = 'quote'): DecisionEntry => ({
    id: `DEC${number}`, number, date: day(ago).slice(0, 10), text, source, sourceKind, by: sourceKind === 'imported' ? undefined : 'web', at: sourceKind === 'imported' ? undefined : day(ago),
  });
  const topic = (x: DecisionEntry, name: string): DecisionEntry => ({ ...x, topic: name });
  return [
    topic(d(101, 12, 'The game is a 2D platformer in a hand-drawn style.', 'Make it a platformer, hand-drawn, nothing 3D.'), 'Scope'),
    topic(d(102, 11, 'Levels are authored as tile maps, not generated at run time.', 'default', 'default'), 'Scope'),
    topic(d(103, 9, 'The pause menu opens with Escape and freezes the simulation.', 'Escape should pause, and the world must stop.'), 'Menus'),
    topic(d(104, 8, 'Footstep sounds follow the surface under the feet.', 'Footsteps should change with the ground.'), 'Audio'),
    topic(d(105, 6, 'Controller support comes after the first public build.', 'default', 'default'), 'Menus'),
    d(106, 5, 'Saves are three slots, no cloud sync in the first version.', 'Three slots is enough, skip cloud.'),
    d(107, 3, 'The credits screen is the last thing to build.', 'carried over from the project table', 'imported'),
    d(108, 1, 'Orders that spend paid credits need an approved quote first.', 'Never spend credits without me saying so.'),
  ];
}

export function mockLessons(): Lesson[] {
  return [
    { id: 'L001', title: 'Name the exact files an art order may touch', level: 'rule', tags: ['art'], rule: 'List the folders an art order may write to; an order without the list changes shared assets by accident.', why: 'A tile order once overwrote shared sprites.', appliesToProject: true, orders: [], file: 'art/scope.md' },
    { id: 'L002', title: 'Show the target frame before the batch', tags: ['art', 'ui'], rule: 'Ask for one target frame, get it approved, and only then render the batch.', why: 'Forty finished images were thrown away because the first one was off.', appliesToProject: true, orders: [], file: 'art/target-frame.md' },
    { id: 'L003', title: 'Loop points are checked by ear', tags: ['audio'], rule: 'After cutting a loop, play it back to back twice; a click at the seam means the cut is wrong.', appliesToProject: true, orders: [], file: 'audio/loops.md' },
    { id: 'L004', title: 'Keep the check cheap', tags: ['code', 'tests'], rule: 'One real run and the cheap hashes before merging; the full suite runs once per batch.', why: 'Per-order full runs cost hours.', appliesToProject: true, orders: [], file: 'code/checks.md' },
    { id: 'L005', title: 'Hold input while a menu is open', tags: ['ui', 'code'], rule: 'A menu must swallow input meant for the game while it is open.', appliesToProject: true, orders: [], file: 'ui/menus.md' },
    { id: 'L006', title: 'Ask before spending credits', level: 'rule', tags: ['art', 'audio', 'spend'], rule: 'Put a quote on the order and wait for its approval before generating anything paid.', why: 'A batch once ran past the budget.', appliesToProject: true, orders: [], file: 'process/spend.md' },
    { id: 'L-ENG-05', title: 'Keep the user data folder name stable', level: 'checklist', tags: ['godot', 'engine'], rule: '- Do not rename the project: saves are lost.\n- Set the folder name explicitly.', why: 'A rename once lost every save.', projects: ['other-game'], appliesToProject: false, orders: [], file: 'engines/godot.md' },
  ];
}
