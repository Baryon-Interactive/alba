import type { RunUsage } from '../api/types.ts';

export interface Pricing { input_per_mtok: number; cached_input_per_mtok: number; output_per_mtok: number; currency: string }
export interface UsageRow extends RunUsage {
  project: string; order: string; run: string; worker: string; engine: string; model: string;
  turn: number; at: string; kind: string; rework: boolean; resume: boolean; open: boolean; merged: boolean;
  signals?: UsageSignal[]; signal_rules?: string; merged_at?: string; subscription?: boolean;
  raw?: Record<string, unknown>; estimate?: number; currency?: string;
  quota?: { window: string; percent: number; shared: boolean }[];
}
export interface WasteRules {
  tokens_without_commit?: number; long_run_tokens?: number; min_cached_share?: number;
  command_output_bytes?: number; repeated_file_reads?: number; failed_repeats?: number;
  reasoning_share?: number; reasoning_by_kind?: Record<string, number>;
}
export interface UsageSignal { kind: string; order: string; run: string; turns: [number, number]; text: string; command?: string; file?: string }
export interface UsageTotal {
  tokens: number; input: number; cached: number; cache_write: number; output: number; reasoning: number;
  known: number; unknown: number; cache_unknown: number; reasoning_unknown: number; estimates: Record<string, number>;
}
export interface UsageGroup extends UsageTotal { key: string; merged_orders?: number; merged_pricing_complete?: boolean }
export interface UsageReport {
  since: string; by: string; rows: UsageGroup[]; total: UsageTotal; omitted?: UsageTotal;
}
export interface UsageDashboard {
  roles?: import('../roles/statistics.ts').RoleWorkerResult[];
  todayProjects: UsageReport; days: { day: string; projects: Record<string, number> }[];
  today: UsageReport; week: UsageReport; workers: UsageReport; projects: UsageReport; daily: UsageReport;
  orders: UsageReport; kinds: UsageReport; mergedKinds: UsageReport; median?: number; p90?: number;
  open: UsageRow[]; signals: UsageSignal[]; warnings: { kind?: string; order?: string; text: string }[];
}
