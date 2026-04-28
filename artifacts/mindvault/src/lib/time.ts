export const MOSCOW_TIME_ZONE = "Europe/Moscow";

const MOSCOW_OFFSET_HOURS = 3;
const DATETIME_LOCAL_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

function toDate(value: string | Date): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Некорректная дата");
  }
  return date;
}

function formatInMoscow(
  value: string | Date,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: MOSCOW_TIME_ZONE,
    ...options,
  }).format(toDate(value));
}

function getMoscowDayKey(value: string | Date): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: MOSCOW_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(toDate(value));

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return `${year}-${month}-${day}`;
}

export function parseMoscowDateTimeLocalToIso(localDateTime: string): string {
  const match = DATETIME_LOCAL_RE.exec(localDateTime);
  if (!match) {
    throw new Error("Некорректный формат даты и времени");
  }

  const [, year, month, day, hours, minutes, seconds = "00", millis = "0"] = match;
  const normalizedMillis = Number(millis.padEnd(3, "0"));
  const utcMillis = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours) - MOSCOW_OFFSET_HOURS,
    Number(minutes),
    Number(seconds),
    normalizedMillis,
  );

  return new Date(utcMillis).toISOString();
}

export function formatMoscowDateTime(value: string | Date): string {
  return formatInMoscow(value, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatMoscowDate(value: string | Date): string {
  return formatInMoscow(value, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function formatMoscowDateShort(value: string | Date): string {
  return formatInMoscow(value, {
    day: "2-digit",
    month: "2-digit",
  });
}

export function formatMoscowTime(value: string | Date): string {
  return formatInMoscow(value, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatMoscowMonthYear(value: string | Date): string {
  return formatInMoscow(value, {
    month: "long",
    year: "numeric",
  });
}

export function isTodayInMoscow(value: string | Date): boolean {
  return getMoscowDayKey(value) === getMoscowDayKey(new Date());
}
