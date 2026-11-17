export type CaptureDoneMode = 'exit' | 'file';

export interface CaptureShotConfig {
  name: string;
  args?: string[];
  command?: string[];
  timeout_seconds: number;
  done?: CaptureDoneMode;
}

export interface CaptureRecipe {
  name: string;
  kinds: string[];
  tags: string[];
  lock: string;
  lock_wait_minutes: number;
  timeout_minutes: number;
  build?: string[];
  build_timeout_minutes: number;
  artifact?: string;
  size?: [number, number];
  launch?: string[];
  done: CaptureDoneMode;
  baseline?: string;
  min_change: number;
  shots: CaptureShotConfig[];
}

export interface CaptureConfig {
  recipes: CaptureRecipe[];
}

export interface CaptureGateResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
}

export interface CaptureManifestShot {
  name: string;
  file: string;
  status: 'ok' | 'failed';
  reason: string;
  exit_code: number | null;
  started: string;
  duration_ms: number;
  bytes?: number;
  sha256?: string;
  width?: number;
  height?: number;
  mean_luminance?: number;
  luminance_stddev?: number;
  dark_fraction?: number;
}

export interface CaptureManifest {
  version: 1;
  tag: string;
  recipe: string;
  report: number | null;
  trial: string | null;
  branch: string;
  revision: string;
  dirty: string[];
  lock: { name: string; waited_ms: number };
  build: { code: number | null; duration_ms: number; log: string } | null;
  artifact: { path: string; mtime: string; sha256: string } | null;
  started: string;
  ended: string;
  status: 'passed' | 'failed';
  reason: string;
  shots: CaptureManifestShot[];
  gates: CaptureGateResult[];
  sheet: string | null;
}

export interface CaptureSummaryShot {
  name: string;
  file: string;
  status: 'ok' | 'failed';
  reason?: string;
  width?: number;
  height?: number;
  sha256?: string;
}

export interface CaptureSummary {
  recipe: string;
  manifest: string;
  sheet: string;
  revision: string;
  status: 'passed' | 'failed';
  reason?: string;
  shots: CaptureSummaryShot[];
  gates: CaptureGateResult[];
}
