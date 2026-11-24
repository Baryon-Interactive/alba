import { fail } from '../i18n.ts';

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  dom: Set<number>;
  months: Set<number>;
  dow: Set<number>;
  domWild: boolean;
  dowWild: boolean;
}

export interface TimetableSpec {
  every_minutes?: number;
  daily_at?: string;
  cron?: string;
}

const MAX_SEARCH_YEARS = 5;

function parseField(raw: string, min: number, max: number, name: string, allowSevenAsSunday = false): { values: Set<number>; wild: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) fail('Cron field "{name}" is empty.', { name });
  const wild = trimmed === '*';
  const values = new Set<number>();
  for (const part of trimmed.split(',')) {
    if (!part) fail('Cron field "{name}" has an empty list item in "{raw}".', { name, raw });
    const slashParts = part.split('/');
    if (slashParts.length > 2) fail('Cron field "{name}" has an invalid step "{part}".', { name, part });
    const [rangePart, stepPart] = slashParts;
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) fail('Cron field "{name}" step "{step}" must be a positive integer.', { name, step: stepPart });
      step = Number(stepPart);
      if (!Number.isInteger(step) || step < 1) fail('Cron field "{name}" step "{step}" must be >= 1.', { name, step: stepPart });
    }
    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const bounds = rangePart.split('-');
      if (bounds.length !== 2 || !/^\d+$/.test(bounds[0]) || !/^\d+$/.test(bounds[1])) {
        fail('Cron field "{name}" has an invalid range "{part}".', { name, part });
      }
      start = Number(bounds[0]);
      end = Number(bounds[1]);
      if (start < min || end > max || start > end) {
        fail('Cron field "{name}" range "{part}" is outside {min}-{max}.', { name, part, min, max });
      }
    } else {
      if (!/^\d+$/.test(rangePart)) fail('Cron field "{name}" has an invalid value "{part}".', { name, part });
      start = Number(rangePart);
      if (start < min || start > max) {
        fail('Cron field "{name}" value "{part}" is outside {min}-{max}.', { name, part, min, max });
      }
      end = stepPart !== undefined ? max : start;
    }
    for (let v = start; v <= end; v += step) {
      values.add(allowSevenAsSunday && v === 7 ? 0 : v);
    }
  }
  if (!values.size) fail('Cron field "{name}" matched no values.', { name });
  return { values, wild };
}

/** Parses a standard 5-field cron expression (minute hour day-of-month month day-of-week, local time). */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    fail('Cron expression "{expr}" must have 5 fields (minute hour day-of-month month day-of-week).', { expr });
  }
  const min = parseField(fields[0], 0, 59, 'minute');
  const hour = parseField(fields[1], 0, 23, 'hour');
  const dom = parseField(fields[2], 1, 31, 'day-of-month');
  const month = parseField(fields[3], 1, 12, 'month');
  const dow = parseField(fields[4], 0, 7, 'day-of-week', true);
  return {
    minutes: min.values,
    hours: hour.values,
    dom: dom.values,
    months: month.values,
    dow: dow.values,
    domWild: dom.wild,
    dowWild: dow.wild,
  };
}

function dayMatches(cron: ParsedCron, year: number, monthIndex: number, day: number): boolean {
  const d = new Date(year, monthIndex, day, 12, 0, 0, 0);
  if (d.getFullYear() !== year || d.getMonth() !== monthIndex || d.getDate() !== day) return false;
  const domOk = cron.dom.has(day);
  const dowOk = cron.dow.has(d.getDay());
  if (cron.domWild && cron.dowWild) return true;
  if (cron.domWild) return dowOk;
  if (cron.dowWild) return domOk;
  return domOk || dowOk;
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

export function cronMatches(cron: ParsedCron, date: Date): boolean {
  return cron.months.has(date.getMonth() + 1)
    && dayMatches(cron, date.getFullYear(), date.getMonth(), date.getDate())
    && cron.hours.has(date.getHours())
    && cron.minutes.has(date.getMinutes());
}

/** Floors a Date to the start of its minute (seconds and ms set to 0). */
export function floorToMinute(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000);
}

/** Formats local YYYYMMDD from a Date. */
export function formatLocalDate(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** Formats local HHMM from a Date. */
export function formatLocalTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}${m}`;
}

/** Formats local calendar day YYYY-MM-DD from a Date. */
export function formatLocalDay(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function cronForSpec(spec: TimetableSpec): ParsedCron | undefined {
  if (spec.cron !== undefined) return parseCron(spec.cron);
  if (spec.daily_at !== undefined) {
    const [hh, mm] = spec.daily_at.split(':').map(Number);
    return parseCron(`${mm} ${hh} * * *`);
  }
  return undefined;
}

/** Returns the earliest planned time strictly after `from`. */
export function nextPlannedAfter(spec: TimetableSpec, from: Date): Date | undefined {
  if (spec.every_minutes !== undefined) {
    const stepMs = spec.every_minutes * 60_000;
    const nextMs = (Math.floor(from.getTime() / stepMs) + 1) * stepMs;
    return new Date(nextMs);
  }
  const cron = cronForSpec(spec);
  if (!cron) return undefined;

  const sortedMonths = [...cron.months].sort((a, b) => a - b);
  const sortedHours = [...cron.hours].sort((a, b) => a - b);
  const sortedMinutes = [...cron.minutes].sort((a, b) => a - b);

  // Start at the next minute strictly after `from`.
  const start = new Date(floorToMinute(from).getTime() + 60_000);
  const maxYear = start.getFullYear() + MAX_SEARCH_YEARS;

  let year = start.getFullYear();
  let month = start.getMonth() + 1;
  let day = start.getDate();
  let hour = start.getHours();
  let minute = start.getMinutes();

  while (year <= maxYear) {
    const nextMonth = sortedMonths.find(m => m >= month);
    if (nextMonth === undefined) {
      year++;
      month = sortedMonths[0];
      day = 1;
      hour = sortedHours[0];
      minute = sortedMinutes[0];
      continue;
    }
    if (nextMonth > month) {
      month = nextMonth;
      day = 1;
      hour = sortedHours[0];
      minute = sortedMinutes[0];
    }
    const maxDay = daysInMonth(year, month - 1);
    let foundDay: number | undefined;
    for (let d = day; d <= maxDay; d++) {
      if (dayMatches(cron, year, month - 1, d)) { foundDay = d; break; }
    }
    if (foundDay === undefined) {
      month++;
      if (month > 12) { year++; month = 1; }
      day = 1;
      hour = sortedHours[0];
      minute = sortedMinutes[0];
      continue;
    }
    if (foundDay > day) {
      day = foundDay;
      hour = sortedHours[0];
      minute = sortedMinutes[0];
    }
    const nextHour = sortedHours.find(h => h >= hour);
    if (nextHour === undefined) {
      day++;
      if (day > maxDay) { month++; day = 1; if (month > 12) { year++; month = 1; } }
      hour = sortedHours[0];
      minute = sortedMinutes[0];
      continue;
    }
    if (nextHour > hour) {
      hour = nextHour;
      minute = sortedMinutes[0];
    }
    const nextMinute = sortedMinutes.find(m => m >= minute);
    if (nextMinute === undefined) {
      hour++;
      if (hour > 23) {
        day++;
        if (day > maxDay) { month++; day = 1; if (month > 12) { year++; month = 1; } }
        hour = sortedHours[0];
      }
      minute = sortedMinutes[0];
      continue;
    }
    const candidate = new Date(year, month - 1, day, hour, nextMinute, 0, 0);
    if (candidate.getTime() > from.getTime() && cronMatches(cron, candidate)) return candidate;
    // Handle DST spring-forward skipped local time by advancing past the candidate minute.
    const bump = new Date(candidate.getTime() + 60_000);
    year = bump.getFullYear();
    month = bump.getMonth() + 1;
    day = bump.getDate();
    hour = bump.getHours();
    minute = bump.getMinutes();
  }
  return undefined;
}

/** Returns the latest planned time at or before `at`. */
export function latestPlannedAtOrBefore(spec: TimetableSpec, at: Date): Date | undefined {
  if (spec.every_minutes !== undefined) {
    const stepMs = spec.every_minutes * 60_000;
    return new Date(Math.floor(at.getTime() / stepMs) * stepMs);
  }
  const cron = cronForSpec(spec);
  if (!cron) return undefined;

  const sortedMonthsDesc = [...cron.months].sort((a, b) => b - a);
  const sortedHoursDesc = [...cron.hours].sort((a, b) => b - a);
  const sortedMinutesDesc = [...cron.minutes].sort((a, b) => b - a);

  const start = floorToMinute(at);
  const minYear = start.getFullYear() - MAX_SEARCH_YEARS;

  let year = start.getFullYear();
  let month = start.getMonth() + 1;
  let day = start.getDate();
  let hour = start.getHours();
  let minute = start.getMinutes();

  while (year >= minYear) {
    const prevMonth = sortedMonthsDesc.find(m => m <= month);
    if (prevMonth === undefined) {
      year--;
      month = sortedMonthsDesc[0];
      day = daysInMonth(year, month - 1);
      hour = sortedHoursDesc[0];
      minute = sortedMinutesDesc[0];
      continue;
    }
    if (prevMonth < month) {
      month = prevMonth;
      day = daysInMonth(year, month - 1);
      hour = sortedHoursDesc[0];
      minute = sortedMinutesDesc[0];
    }
    const maxDay = daysInMonth(year, month - 1);
    if (day > maxDay) {
      day = maxDay;
      hour = sortedHoursDesc[0];
      minute = sortedMinutesDesc[0];
    }
    let foundDay: number | undefined;
    for (let d = day; d >= 1; d--) {
      if (dayMatches(cron, year, month - 1, d)) { foundDay = d; break; }
    }
    if (foundDay === undefined) {
      month--;
      if (month < 1) { year--; month = 12; }
      day = daysInMonth(year, month - 1);
      hour = sortedHoursDesc[0];
      minute = sortedMinutesDesc[0];
      continue;
    }
    if (foundDay < day) {
      day = foundDay;
      hour = sortedHoursDesc[0];
      minute = sortedMinutesDesc[0];
    }
    const prevHour = sortedHoursDesc.find(h => h <= hour);
    if (prevHour === undefined) {
      day--;
      if (day < 1) { month--; if (month < 1) { year--; month = 12; } day = daysInMonth(year, month - 1); }
      hour = sortedHoursDesc[0];
      minute = sortedMinutesDesc[0];
      continue;
    }
    if (prevHour < hour) {
      hour = prevHour;
      minute = sortedMinutesDesc[0];
    }
    const prevMinute = sortedMinutesDesc.find(m => m <= minute);
    if (prevMinute === undefined) {
      hour--;
      if (hour < 0) {
        day--;
        if (day < 1) { month--; if (month < 1) { year--; month = 12; } day = daysInMonth(year, month - 1); }
        hour = sortedHoursDesc[0];
      }
      minute = sortedMinutesDesc[0];
      continue;
    }
    const candidate = new Date(year, month - 1, day, hour, prevMinute, 0, 0);
    if (candidate.getTime() <= at.getTime() && cronMatches(cron, candidate)) return candidate;
    // Handle DST skipped local time by stepping backward one minute.
    const back = new Date(candidate.getTime() - 60_000);
    year = back.getFullYear();
    month = back.getMonth() + 1;
    day = back.getDate();
    hour = back.getHours();
    minute = back.getMinutes();
  }
  return undefined;
}

/** Human-readable cadence summary for CLI and console display. */
export function cadenceLabel(spec: TimetableSpec): string {
  if (spec.every_minutes !== undefined) return `every ${spec.every_minutes} min`;
  if (spec.daily_at !== undefined) return `daily ${spec.daily_at}`;
  if (spec.cron !== undefined) return `cron ${spec.cron}`;
  return '';
}
