import type { ProgressView } from './types.ts';
export type { RunTranscript, TranscriptEdit, TranscriptEntry, TranscriptEntryKind, TranscriptEntryState, TranscriptPlanStep } from './types.ts';

export interface LiveActivity { at: string; kind: string; summary: string; exit_code?: number; duration_seconds?: number; output_tail?: string }
export interface LiveCurrent { id: string; kind: string; command: string; started_at: string; elapsed_seconds: number }
export interface TokenCounts { input_tokens: number; cached_input_tokens: number; output_tokens: number }
export interface LiveState {
  phase: 'thinking' | 'running_command' | 'editing_files' | 'waiting_long_command' | 'idle';
  current?: LiveCurrent; recent: LiveActivity[]; messages: { at: string; text: string }[]; plan?: ProgressView;
  usage: TokenCounts & { turns: number; per_turn: TokenCounts[] };
  files_changed: string[]; diff_stat?: string; last_event_at?: string; inbox_opened_at?: string;
  commands: number; failed_commands: number; long_command_seconds: number;
}
export interface LiveSummary extends TokenCounts { turns: number; commands: number; failed_commands: number; long_command_minutes: number; files_changed: string[] }
export interface OutboxEntry {
  id: string; at: string; kind: 'question' | 'blocker' | 'note' | 'eta'; text: string;
  options?: string[]; reply?: string; answered?: { id: string; at: string; text: string };
  /** When alba picked the entry up (its own clock; `at` is what the worker wrote, which may be off). */
  received?: string;
}
export interface ThreadEntry { id: string; at: string; kind: string; text: string; options?: string[]; reply?: string; delivery?: 'sent' | 'read' | 'answered' }
