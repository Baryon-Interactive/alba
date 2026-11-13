import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import { designHistory, librarySnapshot, readLibrary } from '../design/library.ts';
import { checkDesign, readDesign, searchDesign, showDesign } from '../design/read.ts';
import { designTemplate } from '../design/template.ts';
import { DesignError } from '../design/model.ts';
import { measurementViews } from '../design/measure.ts';

/** Read API exports return a bundle; only the CLI/export backup writer touches directories. */
export function designGet(project: ProjectConfig, orders: Orders, parts: string[], q: (key: string) => string | undefined): unknown {
  const [command, id] = parts;
  if (!command) return readDesign(project, orders, { system: q('system'), kind: q('kind'), query: q('query') });
  if (command === 'systems' && parts.length === 1) return readLibrary(project).system;
  if (command === 'show' && parts.length === 2) return showDesign(project, id);
  if (command === 'search' && parts.length === 1) return searchDesign(project, q('q') ?? '');
  if (command === 'history' && parts.length <= 2) return designHistory(project, id ?? q('id'));
  if (command === 'check' && parts.length === 1) return checkDesign(project, orders);
  if (command === 'export' && parts.length === 1) return { ...librarySnapshot(project), history: designHistory(project), measurements: measurementViews(project, orders) };
  if (command === 'measurements' && parts.length === 1) return measurementViews(project, orders);
  if (command === 'import-template' && parts.length === 1) return designTemplate();
  throw new DesignError('No such design read route.', 404);
}
