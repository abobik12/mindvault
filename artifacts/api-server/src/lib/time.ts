export const MOSCOW_TIME_ZONE = "Europe/Moscow";

const MOSCOW_OFFSET_HOURS = 3;
const HAS_TIME_ZONE_RE = /([zZ]|[+\-]\d{2}:\d{2})$/;
const LOCAL_DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;

function asDate(value: string | Date): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Некорректная дата");
  }
  return date;
}

function getMoscowDateParts(date: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: MOSCOW_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const record: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      record[part.type] = part.value;
    }
  }

  return record;
}

function parseAsMoscowLocal(value: string): Date | null {
  const match = LOCAL_DATE_TIME_RE.exec(value);
  if (!match) return null;

  const [, year, month, day, hour = "00", minute = "00", second = "00", millis = "0"] = match;
  const normalizedMillis = Number(millis.padEnd(3, "0"));
  const utcMillis = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour) - MOSCOW_OFFSET_HOURS,
    Number(minute),
    Number(second),
    normalizedMillis,
  );

  return new Date(utcMillis);
}

export function parseReminderDateTime(value: string | null | undefined): Date | null {
  if (!value) return null;

  if (HAS_TIME_ZONE_RE.test(value)) {
    return asDate(value);
  }

  const local = parseAsMoscowLocal(value);
  if (local) return local;

  return asDate(value);
}

export function formatMoscowDateTime(value: string | Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: MOSCOW_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(asDate(value));
}

export function getCurrentMoscowDateTimeForModel(): string {
  const parts = getMoscowDateParts(new Date());
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+03:00`;
}
