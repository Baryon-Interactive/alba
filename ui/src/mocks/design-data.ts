import type { DesignBundle } from '@/lib/design';

/** Invented gameplay systems, shared by the mock server and component checks. */
export function seedDesign(): DesignBundle {
  const stamp = { version: 1, updated: '2026-10-28T09:00:00Z' };
  const measure = { argv: ['node', 'tools/measure-flight.mjs'], timeout_minutes: 5, value: { json_pointer: '/value' }, when: { after_merge_paths: ['game/**'], every_hours: 24 } };
  const system = (code: string, name: string, status: 'playable' | 'prototype' | 'not-started', summary: string) => ({ ...stamp, code, name, status, summary, source_refs: ['docs/game.md'], code_globs: ['game/**/*.ts'], data_globs: ['content/**/*.json'], verified_commit: 'a1b2c3d', verified_at: '2026-10-28T09:00:00Z' });
  return {
    system: [system('GLD', 'Glider flight', 'playable', 'Trade altitude for speed; thermals reward careful route planning.'), system('TRV', 'Trail discovery', 'prototype', 'Explore winding trails and reveal landmarks.'), system('CFT', 'Camp crafting', 'not-started', 'Build useful camp equipment from gathered materials.')],
    rule: [
      { ...stamp, id: 'GLD-R01', system: 'GLD', text: 'A glider gains lift while inside a thermal, once per simulation tick.', sources: [{ kind: 'doc', ref: 'docs/game.md#flight' }], status: 'active', superseded_by: null, implementation: 'done', evidence: [{ kind: 'order', ref: 'AR1' }] },
      { ...stamp, id: 'GLD-R02', system: 'GLD', text: 'Banking consumes speed in proportion to turn intensity.', sources: [{ kind: 'doc', ref: 'docs/game.md#flight' }], status: 'active', superseded_by: null, implementation: 'partial', evidence: [{ kind: 'file', ref: 'game/flight.ts' }] },
      { ...stamp, id: 'GLD-R03', system: 'GLD', text: 'Landing inside the camp boundary restores stamina.', sources: [{ kind: 'doc', ref: 'docs/game.md#landing' }], status: 'active', superseded_by: null, implementation: 'none', evidence: [] },
      { ...stamp, id: 'GLD-R04', system: 'GLD', text: 'Thermals grant a fixed burst of altitude on entry.', sources: [{ kind: 'doc', ref: 'docs/game.md#flight' }], status: 'retired', superseded_by: 'GLD-R01', implementation: 'none', evidence: [] },
      { ...stamp, id: 'TRV-R01', system: 'TRV', text: 'Each landmark reveals the next trail fork.', sources: [{ kind: 'doc', ref: 'docs/game.md#trails' }], status: 'active', superseded_by: null, implementation: 'none', evidence: [] },
    ],
    formula: [{ ...stamp, id: 'GLD-F01', system: 'GLD', expression: 'lift = GLD.flight.lift * thermal_strength * delta_time', variables: ['GLD.flight.lift', 'thermal_strength', 'delta_time'], number_kind: 'float', rounding: 'No rounding until display', timing: 'Each fixed simulation tick', code_refs: ['game/flight.ts:24'], notes: 'Thermal strength falls off toward its boundary.' }],
    param: [
      { ...stamp, id: 'GLD.flight.lift', system: 'GLD', location: { file: 'content/flight.json', pointer: '/glider/lift' }, meaning: 'Upward acceleration at the center of a thermal.', unit: 'm/s²', type: 'float', range_min: 2, range_max: 8, source: 'tuned', source_ref: 'Wind tunnel tuning', rules: ['GLD-R01'], formulas: ['GLD-F01'] },
      { ...stamp, id: 'GLD.flight.drag', system: 'GLD', location: { file: 'content/flight.json', pointer: '/glider/drag' }, meaning: 'Speed lost each second while banking.', unit: 'm/s²', type: 'float', range_min: 0.1, range_max: 0.8, source: 'baseline', source_ref: 'Initial flight prototype', rules: ['GLD-R02'], formulas: [] },
      { ...stamp, id: 'TRV.trail.radius', system: 'TRV', location: { file: 'content/trails.json', pointer: '/revealRadius' }, meaning: 'Distance required to discover a landmark.', unit: 'm', type: 'int', range_min: 10, range_max: 50, source: 'baseline', source_ref: 'Exploration prototype', rules: ['TRV-R01'], formulas: [] },
    ],
    target: [
      { ...stamp, measure, id: 'GLD-T01', system: 'GLD', metric: 'Time aloft on the introductory route', min: 45, max: 80, unit: 's', command: 'node tools/measure-flight.mjs --route intro', last_value: 92, measured_commit: 'c3d4e5f', measured_at: '2026-10-29T10:00:00Z', evidence: [{ kind: 'report', ref: 'AR1#r1' }] },
      { ...stamp, measure, id: 'GLD-T02', system: 'GLD', metric: 'Safe landing rate across practice runs', min: 80, max: 100, unit: '%', command: 'node tools/measure-flight.mjs --landings', last_value: 88, measured_commit: 'c3d4e5f', measured_at: '2026-10-29T10:00:00Z', evidence: [{ kind: 'report', ref: 'AR1#r1' }] },
      { ...stamp, measure, id: 'GLD-T03', system: 'GLD', metric: 'Stamina remaining at the camp', min: 20, max: null, unit: '%', command: 'node tools/measure-flight.mjs --stamina', last_value: null, measured_commit: null, measured_at: null, evidence: [] },
    ],
    gap: [
      { ...stamp, id: 'GLD-G01', system: 'GLD', text: 'Tune thermal lift so the introductory route stays within the time budget.', refs: ['GLD.flight.lift', 'GLD-T01'], order: null, status: 'open', closed_by: null },
      { ...stamp, id: 'GLD-G02', system: 'GLD', text: 'Finish banking drag integration.', refs: ['GLD-R02'], order: 'AR1', status: 'open', closed_by: null },
    ],
    milestone: [
      { ...stamp, id: 'M-FIRST_FLIGHT', name: 'First flight', position: 1, status: 'active', criteria: [{ target: 'GLD-T01' }, { target: 'GLD-T02' }, { target: 'GLD-T03' }, { text: 'Review the landing tutorial with a new player.' }] },
      { ...stamp, id: 'M-OPEN_TRAILS', name: 'Open the trails', position: 2, status: 'not-started', criteria: [{ text: 'Three landmarks connected by discoverable trails.' }] },
    ],
    term: [{ ...stamp, term: 'Thermal', meaning: 'A rising column of warm air that gives the glider lift.', avoid: ['boost zone'], system: 'GLD' }, { ...stamp, term: 'Landmark', meaning: 'A visible destination that reveals nearby trails.', avoid: ['checkpoint'], system: 'TRV' }],
    decision_link: [],
    measurements: [
      { target: 'GLD-T01', due: false, running: false, last: { target: 'GLD-T01', at: '2026-10-29T10:00:00Z', commit: 'c3d4e5f', status: 'ok', value: 92, log: '.alba/design/measurements/flight.log', definition: '' } },
      { target: 'GLD-T02', due: false, running: false, last: { target: 'GLD-T02', at: '2026-10-29T11:00:00Z', commit: 'c3d4e5f', status: 'failed', reason: 'Practice run exited 1: landing fixture unavailable.', log: '.alba/design/measurements/landing.log', definition: '' } },
      { target: 'GLD-T03', due: true, running: false },
    ],
    resolved_values: [{ id: 'GLD.flight.lift', value: 11.5 }, { id: 'GLD.flight.drag', value: 0.35 }, { id: 'TRV.trail.radius', value: 25 }],
    history: [{ id: 1, at: '2026-10-28T09:00:00Z', kind: 'param', entity: 'GLD.flight.lift', op: 'create', before: null, after: { ...stamp, id: 'GLD.flight.lift', system: 'GLD', location: { file: 'content/flight.json', pointer: '/glider/lift' }, meaning: 'Upward acceleration at the center of a thermal.', unit: 'm/s²', type: 'float', range_min: 2, range_max: 8, source: 'tuned', source_ref: 'Wind tunnel tuning', rules: ['GLD-R01'], formulas: ['GLD-F01'] }, by: 'web', order: null, decision: null, changeset: 'demo-change' }],
  };
}
