export interface RoundConfig { every_minutes: number; enabled: boolean }
export interface MonitorConfig { stale_minutes: number }

export function roundConfig(raw: unknown): RoundConfig {
  const v = raw as Record<string, unknown>;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['enabled', 'every_minutes'].includes(k))
    || typeof v.every_minutes !== 'number' || !Number.isFinite(v.every_minutes) || v.every_minutes <= 0
    || (v.enabled !== undefined && typeof v.enabled !== 'boolean')) throw new Error('producer.round requires positive every_minutes and optional boolean enabled.');
  return { every_minutes: v.every_minutes, enabled: v.enabled === true };
}

export function monitorConfig(raw: unknown): MonitorConfig {
  const v = raw as Record<string, unknown>;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => k !== 'stale_minutes')
    || (v.stale_minutes !== undefined && (typeof v.stale_minutes !== 'number' || !Number.isFinite(v.stale_minutes) || v.stale_minutes <= 0))) throw new Error('monitor.stale_minutes must be positive.');
  return { stale_minutes: Number(v.stale_minutes ?? 45) };
}
