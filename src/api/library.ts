import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { approveSetting, artView } from '../library/art.ts';
import { choosePick, listPicks } from '../library/picks.ts';
import { cachedFile, readRefs } from '../library/refs.ts';
import { approveQuote, spendView } from '../library/spend.ts';
import { ledgersOf, usageView } from '../library/usage.ts';
import type { Orders } from '../orders/service.ts';
import type { WorkersFile } from '../workers/config.ts';
import { ApiFailure } from './handler.ts';
import type * as A from './types.ts';

/** What the library calls need from the interface: the project, its orders, a way to answer. */
export interface LibraryCall {
  /** The project's config and orders; asked for only once the call is known to be one of the library's. */
  view: () => { config: ProjectConfig; orders: Orders };
  workers?: WorkersFile;
  now: Date;
  parts: string[];
  q: (name: string) => string | undefined;
  reply: (status: number, body: unknown) => void;
  serve: (file: string, type: string) => void;
}

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.img': 'application/octet-stream' };

const text = (body: Record<string, unknown>, key: string): string | undefined => {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ApiFailure(400, 'bad_request', `"${key}" must be a string.`);
  return v;
};

/** GET /api/picks, /api/art, /api/art/ref/:id, /api/spend, /api/usage. True when the call was one of them. */
export function libraryGet(c: LibraryCall): boolean {
  const { parts } = c;
  const [head] = parts;
  if (!['picks', 'art', 'spend', 'usage'].includes(head)) return false;
  const view = c.view();
  if (head === 'picks' && parts.length === 1) { c.reply(200, listPicks(view.config, view.orders) satisfies A.PickList); return true; }
  if (head === 'art' && parts.length === 1) { c.reply(200, artView(view.config) satisfies A.ArtView); return true; }
  if (head === 'art' && parts[1] === 'ref' && parts.length === 3) {
    const art = view.config.art;
    const ref = art ? readRefs(art).refs.find(r => r.id === parts[2]) : undefined;
    if (!ref) throw new ApiFailure(404, 'not_found', `No reference "${parts[2]}".`);
    const have = cachedFile(view.config, ref);
    if (!have) throw new ApiFailure(404, 'not_found', `The picture of reference "${parts[2]}" is not fetched yet (alba refs fetch).`);
    c.serve(have.file, IMAGE_TYPES[path.extname(have.file).toLowerCase()] ?? 'application/octet-stream');
    return true;
  }
  if (head === 'spend' && parts.length === 1) { c.reply(200, spendView(view.config) satisfies A.SpendView); return true; }
  if (head === 'usage' && parts.length === 1) {
    const days = Number(c.q('days') ?? 7);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new ApiFailure(400, 'bad_request', '"days" must be a whole number from 1 to 90.');
    c.reply(200, usageView(view.config, view.orders, ledgersOf(view.config, c.workers), c.now, days) satisfies A.ExternalUsage);
    return true;
  }
  return false;
}

/** POST /api/picks/:id/choose, /api/art/settings/:id/approve, /api/spend/:id/approve. True when the call was one of them. */
export function libraryPost(c: LibraryCall, body: Record<string, unknown>): boolean {
  const { parts } = c;
  if (!['picks', 'art', 'spend'].includes(parts[0])) return false;
  const view = c.view();
  if (parts[0] === 'picks' && parts[2] === 'choose' && parts.length === 3) {
    const choice = body.choice;
    if (!Array.isArray(choice) || choice.some(k => typeof k !== 'string')) throw new ApiFailure(400, 'bad_request', '"choice" must be a list of option keys.');
    const result = choosePick(view.config, view.orders, parts[1], { choice: choice as string[], note: text(body, 'note'), who: text(body, 'who'), fingerprint: text(body, 'fingerprint') });
    c.reply(200, result satisfies A.PickChooseResult);
    return true;
  }
  if (parts[0] === 'art' && parts[1] === 'settings' && parts[3] === 'approve' && parts.length === 4) {
    c.reply(200, approveSetting(view.config, view.orders, parts[2], { note: text(body, 'note'), who: text(body, 'who'), fingerprint: text(body, 'fingerprint') }) satisfies A.ArtSetting);
    return true;
  }
  if (parts[0] === 'spend' && parts[2] === 'approve' && parts.length === 3) {
    const cap = body.cap;
    if (typeof cap !== 'number' || !Number.isFinite(cap)) throw new ApiFailure(400, 'bad_request', '"cap" is required and must be a number.');
    c.reply(200, approveQuote(view.config, view.orders, parts[1], { cap, note: text(body, 'note'), who: text(body, 'who'), fingerprint: text(body, 'fingerprint') }) satisfies A.SpendQuote);
    return true;
  }
  return false;
}
