export interface ScheduleTiming {
  timeZone: string;
  hour: number;
  minute: number;
  /** null means every day; otherwise 0 is Sunday and 6 is Saturday. */
  weekday: number | null;
}

interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

function localTime(format: Intl.DateTimeFormat, instant: number): LocalTime {
  const parts = format.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => {
    const value = parts.find((item) => item.type === type)?.value;
    if (value === undefined) throw new Error(`Missing ${type} in time zone conversion.`);
    return Number(value);
  };
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
  };
}

function asUtc(value: LocalTime): number {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);
}

function validate(timing: ScheduleTiming, after: number): void {
  if (
    !Number.isFinite(new Date(after).getTime()) ||
    !Number.isInteger(timing.hour) ||
    timing.hour < 0 ||
    timing.hour > 23 ||
    !Number.isInteger(timing.minute) ||
    timing.minute < 0 ||
    timing.minute > 59 ||
    (timing.weekday !== null && (!Number.isInteger(timing.weekday) || timing.weekday < 0 || timing.weekday > 6))
  ) {
    throw new Error('Invalid schedule timing.');
  }
}

/**
 * Return the first occurrence strictly after `after`. A nonexistent local time is skipped;
 * an ambiguous local time runs only at its earlier instant.
 */
export function nextScheduleTime(timing: ScheduleTiming, after: number): number {
  validate(timing, after);
  const format = formatter(timing.timeZone);
  const current = localTime(format, after);
  const firstDay = Date.UTC(current.year, current.month - 1, current.day);

  for (let dayOffset = 0; dayOffset <= 15; dayOffset++) {
    const day = new Date(firstDay + dayOffset * 86_400_000);
    if (timing.weekday !== null && day.getUTCDay() !== timing.weekday) continue;

    const intended: LocalTime = {
      year: day.getUTCFullYear(),
      month: day.getUTCMonth() + 1,
      day: day.getUTCDate(),
      hour: timing.hour,
      minute: timing.minute,
    };
    const wall = asUtc(intended);
    const offsets = new Set<number>();
    for (let sample = wall - 172_800_000; sample <= wall + 172_800_000; sample += 21_600_000) {
      offsets.add(asUtc(localTime(format, sample)) - sample);
    }
    const matches = [...offsets]
      .map((offset) => wall - offset)
      .filter((instant) => asUtc(localTime(format, instant)) === wall)
      .sort((a, b) => a - b);
    if (matches.length && matches[0] > after) return matches[0];
  }
  throw new Error('Could not calculate the next schedule time.');
}

/** Collapse all due occurrences into one pending decision without executing any of them. */
export function collectMissedSchedules(timing: ScheduleTiming, nextDue: number, now: number) {
  validate(timing, now);
  formatter(timing.timeZone);
  if (!Number.isFinite(new Date(nextDue).getTime())) throw new Error('Invalid next schedule time.');
  let count = 0;
  let latest: number | null = null;
  let next = nextDue;
  while (next <= now) {
    count++;
    latest = next;
    next = nextScheduleTime(timing, next);
  }
  return { count, latest, next };
}
