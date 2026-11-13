import { textConventions } from '../i18n.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { readStateFile, readStateJson, updateStateJson, writeStateFile } from '../orders/state-files.ts';
import { readFacts } from './facts/snapshot.ts';

export interface DirectorMessage {
  id: string; at: string; text: string; answer: string;
  status: 'queued' | 'running' | 'done' | 'error'; error?: string; warnings: string[];
  factIds?: string[];
  tools?: import('./session.ts').SessionToolCall[];
  narration?: string[];
  completedAt?: string;
}
export interface DirectionVersion {
  version: number; at: string; priorities: string; stop: string; constraints: string; notes: string;
}
export interface DirectionProposal {
  at?: string; rejectionReason?: string;
  id: string; messageId: string; baseVersion: number; direction: Omit<DirectionVersion, 'version' | 'at'>;
  status: 'proposed' | 'accepted' | 'rejected' | 'refused';
}
const CHAT = '_producer-chat.json';
const DIRECTION = '_producer-direction.json';
const EDITS = '_producer-direction-proposals.json';
export const ACTIVE_CHAT = '_producer-active-chat.json';
export const directorMessages = (p: ProjectConfig) => readStateJson<DirectorMessage[]>(p, CHAT, []);
export const directionVersions = (p: ProjectConfig) => readStateJson<DirectionVersion[]>(p, DIRECTION, []);
export const standingDirection = (p: ProjectConfig) => directionVersions(p).at(-1) ?? { version: 0, at: '', priorities: '', stop: '', constraints: '', notes: '' };
export const directionProposals = (p: ProjectConfig) => readStateJson<DirectionProposal[]>(p, EDITS, []);
export function postDirectorMessage(p: ProjectConfig, text: string): DirectorMessage {
  if (!p.producer.enabled) throw new Error('The producer is disabled.');
  if (!text.trim() || text.length > 16000) throw new Error('A message must contain 1–16,000 characters.');
  const message: DirectorMessage = { id: randomUUID(), at: new Date().toISOString(), text: text.trim(), answer: '', status: 'queued', warnings: [] };
  updateStateJson<DirectorMessage[]>(p, CHAT, [], rows => [...rows, message]);
  return message;
}
export function updateDirectorMessage(p: ProjectConfig, id: string, patch: Partial<DirectorMessage>): void {
  updateStateJson<DirectorMessage[]>(p, CHAT, [], rows => rows.map(row => row.id === id ? { ...row, ...patch } : row));
}
export function proposeDirection(p: ProjectConfig, direction: DirectionProposal['direction']): DirectionProposal {
  const messageId = readStateJson<string | null>(p, ACTIVE_CHAT, null);
  if (!messageId || directorMessages(p).find(m => m.id === messageId)?.status !== 'running') throw new Error('Direction edits require an active director conversation.');
  if (Object.values(direction).some(v => typeof v !== 'string' || v.length > 16000)) throw new Error('Direction fields must be bounded text.');
  const proposal: DirectionProposal = { id: randomUUID(), messageId, at: new Date().toISOString(), baseVersion: standingDirection(p).version, direction, status: 'proposed' };
  updateStateJson<DirectionProposal[]>(p, EDITS, [], rows => [...rows, proposal]);
  return proposal;
}
export function decideDirection(p: ProjectConfig, id: string, accept: boolean, reason?: string): DirectionProposal {
  let result: DirectionProposal | undefined;
  updateStateJson<DirectionProposal[]>(p, EDITS, [], rows => {
    const item = rows.find(row => row.id === id);
    if (!item) throw new Error('No such direction proposal.');
    if (item.status === 'proposed') {
      item.status = !accept ? 'rejected' : standingDirection(p).version !== item.baseVersion ? 'refused' : 'accepted';
      if (!accept && reason) item.rejectionReason = reason.slice(0, 16000);
      if (item.status === 'accepted') {
        const next = { ...item.direction, version: item.baseVersion + 1, at: new Date().toISOString() };
        writeStateFile(p, DIRECTION, JSON.stringify([...directionVersions(p), next]));
        writeStateFile(p, 'producer-direction.md', `# Standing direction (version ${next.version})\n\n## Priorities\n${next.priorities}\n\n## Stop\n${next.stop}\n\n## Constraints\n${next.constraints}\n\n## Notes (${next.at})\n${next.notes}\n`);
      }
    }
    result = item;
    return rows;
  });
  return result!;
}
export function producerGoals(p: ProjectConfig): string | null {
  const stored = readStateFile(p, 'goals.md');
  if (stored !== undefined) return stored.slice(0, 16000);
  for (const file of [path.join(p.state_dir, 'goals.md'), path.join(path.dirname(p.file), 'goals.md'), path.join(path.dirname(p.file), 'goals.yaml')]) {
    if (existsSync(file)) return readFileSync(file, 'utf8').slice(0, 16000);
  }
  return null;
}

/** Snapshot boundary shared by chat and MCP; absence is data, never a reason to recompute on HTTP. */
export function producerSnapshot(p: ProjectConfig, kind: 'facts' | 'constraint'): unknown {
  if (kind === 'constraint') return readFacts(p)?.analysis?.constraint ?? null;
  return readFacts(p) ?? null;
}
export function snapshotFactIds(snapshot: unknown): string[] {
  const ids = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith('F:')) ids.add(key);
      if ((key === 'id' || key === 'factId') && typeof child === 'string' && child.startsWith('F:')) ids.add(child);
      visit(child);
    }
  };
  visit(snapshot); return [...ids];
}
export function validateFactCitations(answer: string, ids: string[], context: { director?: string; keys?: string[]; tagPattern?: string } = {}): string[] {
  const warnings: string[] = [];
  const factPattern = /F:[\w%./:-]+/g;
  const text = answer.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|(`+)[\s\S]*?\1/g, '');
  const knownNumbers = new Set(`${context.director ?? ''} ${(context.keys ?? []).join(' ')}`.match(textConventions.conversation_state_3) ?? []);
  for (const id of new Set(text.match(factPattern) ?? [])) if (!ids.includes(id.replace(/[.:]+$/, ''))) warnings.push(`Unknown fact id: ${id}`);
  for (const line of text.split(textConventions.conversation_state_4)) {
    if (/^\s*#{1,6}\s/.test(line)) continue;
    let prose = line.replace(factPattern, '').replace(textConventions.conversation_state_5, '')
      .replace(textConventions.conversation_state_6, '')
      .replace(/\b[0-9a-f]{7,64}\b/gi, '').replace(/\b[A-Z][A-Z0-9_-]*\d[A-Z0-9_-]*\b/g, '');
    if (context.tagPattern) prose = prose.replace(new RegExp(`(?<![\\w])(?:${context.tagPattern})(?![\\w])`, 'g'), '');
    for (const key of context.keys ?? []) prose = prose.split(key).join('');
    const numbers = prose.match(textConventions.conversation_state_7) ?? [];
    if (numbers.some(n => !knownNumbers.has(n)) && !textConventions.conversation_state_8.test(line) && !(line.match(factPattern) ?? []).some(id => ids.includes(id.replace(/[.:]+$/, '')))) warnings.push(`Uncited number: ${line.slice(0, 200)}`);
  }
  return warnings;
}
