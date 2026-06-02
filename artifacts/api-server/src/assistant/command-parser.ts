export type KeywordCommand =
  | { kind: "note"; text: string }
  | { kind: "reminder"; text: string }
  | { kind: "list"; text: string };

export type ParsedList = {
  title: string;
  items: string[];
};

export type ParsedReminder = {
  reminderAt: Date | null;
  hasDate: boolean;
  hasTime: boolean;
  text: string;
};

export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

export function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function titleFromText(value: string, fallback: string): string {
  const normalized = compact(value);
  if (!normalized) return fallback;
  return normalized.length > 90 ? `${normalized.slice(0, 87)}...` : normalized;
}

function capitalizeTitle(value: string): string {
  const normalized = compact(value);
  if (!normalized) return normalized;
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function getKeywordCommand(message: string): KeywordCommand | null {
  const match = /^\s*(заметка|напоминание|список)(?=\s|[:：-]|$)[\s:：-]*/i.exec(message);
  if (!match) return null;

  const keyword = match[1].toLowerCase();
  const text = message.slice(match[0].length).trim();
  if (keyword === "заметка") return { kind: "note", text };
  if (keyword === "напоминание") return { kind: "reminder", text };
  return { kind: "list", text };
}

export function isLikelyQuestion(message: string): boolean {
  const normalized = normalizeText(message);
  return (
    message.includes("?") ||
    /^(как|что|почему|зачем|какие|какой|какая|где|когда|можешь|помоги|объясни|расскажи|найди|покажи)\b/i.test(normalized)
  );
}

export function parseListCommand(text: string): ParsedList | null {
  const source = text.trim();
  if (!source) return null;

  const colonIndex = source.search(/[:：]/);
  let title = "Список";
  let itemsSource = source;

  if (colonIndex > 0) {
    title = capitalizeTitle(titleFromText(source.slice(0, colonIndex), "Список"));
    itemsSource = source.slice(colonIndex + 1);
  } else if (/^купить(?=\s|$)/i.test(source)) {
    title = "Покупки";
    itemsSource = source.replace(/^купить(?=\s|$)/i, "");
  }

  const items = itemsSource
    .split(/[\n;,]+/g)
    .map((entry) => compact(entry.replace(/^[-*•\d.)\s]+/, "")))
    .filter(Boolean);

  if (items.length === 0) return null;
  return { title, items };
}

export function serializeListContent(items: string[]): string {
  return JSON.stringify({
    kind: "todo-list",
    items: items.map((text, index) => ({
      id: `item-${Date.now()}-${index}`,
      text,
      done: false,
    })),
  });
}

export function looksLikeListCandidate(message: string): boolean {
  if (isLikelyQuestion(message)) return false;
  if (getKeywordCommand(message)) return false;
  if (/(измени|обнови|перенеси|переименуй|исправь)/i.test(message) || /(удали|удалить|сотри)/i.test(message) || /перемест|перенеси|переименуй/i.test(message)) return false;
  const parsed = parseListCommand(message);
  return Boolean(parsed && parsed.items.length >= 2);
}

function numberFromRussian(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const normalized = normalizeText(value);
  if (normalized === "час" || normalized === "один" || normalized === "одну" || normalized === "1") return 1;
  if (normalized === "два" || normalized === "две" || normalized === "2") return 2;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getMoscowDayIndex(): number {
  const now = new Date();
  const shiftedToMoscow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return shiftedToMoscow.getUTCDay();
}

function getMoscowParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(pick("year")),
    month: Number(pick("month")),
    day: Number(pick("day")),
    hour: Number(pick("hour")),
    minute: Number(pick("minute")),
  };
}

function moscowLocalDate(dayOffset = 0, hour = 9, minute = 0): Date {
  const parts = getMoscowParts();
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset, hour - 3, minute, 0, 0);
  return new Date(utc);
}

export function parseReminderCommand(text: string): ParsedReminder {
  let rest = ` ${text} `;
  const normalized = normalizeText(text);

  const relativeHours = /через\s+(?:(\d+|один|одну|два|две)\s+)?час(?:а|ов)?/i.exec(normalized);
  if (relativeHours) {
    const hours = numberFromRussian(relativeHours[1], 1);
    rest = rest.replace(/через\s+(?:(\d+|один|одну|два|две)\s+)?час(?:а|ов)?/i, " ");
    return {
      reminderAt: new Date(Date.now() + hours * 60 * 60 * 1000),
      hasDate: true,
      hasTime: true,
      text: compact(rest),
    };
  }

  const explicitTime = /(?:^|\s)в\s*(\d{1,2})(?::|\.?)(\d{2})?\b/i.exec(text);
  const hasTime = Boolean(explicitTime);
  const hour = explicitTime ? Number(explicitTime[1]) : 9;
  const minute = explicitTime?.[2] ? Number(explicitTime[2]) : 0;

  const relativeDays = /через\s+(\d+|один|одну|два|две)\s+д(?:ень|ня|ней)/i.exec(normalized);
  let dayOffset: number | null = null;
  if (normalized.includes("послезавтра")) dayOffset = 2;
  else if (normalized.includes("завтра")) dayOffset = 1;
  else if (normalized.includes("сегодня")) dayOffset = 0;
  else if (relativeDays) dayOffset = numberFromRussian(relativeDays[1], 1);

  if (dayOffset !== null) {
    rest = rest
      .replace(/послезавтра|завтра|сегодня/gi, " ")
      .replace(/через\s+(\d+|один|одну|два|две)\s+д(?:ень|ня|ней)/gi, " ");
    if (explicitTime) rest = rest.replace(/(?:^|\s)в\s*\d{1,2}(?::|\.?)\d{0,2}\b/i, " ");
    return {
      reminderAt: hasTime ? moscowLocalDate(dayOffset, hour, minute) : null,
      hasDate: true,
      hasTime,
      text: compact(rest),
    };
  }

  const weekdays = [
    { key: "воскресенье", index: 0 },
    { key: "понедельник", index: 1 },
    { key: "вторник", index: 2 },
    { key: "среду", index: 3 },
    { key: "среда", index: 3 },
    { key: "четверг", index: 4 },
    { key: "пятницу", index: 5 },
    { key: "пятница", index: 5 },
    { key: "субботу", index: 6 },
    { key: "суббота", index: 6 },
  ];
  const weekday = weekdays.find((entry) => normalized.includes(entry.key));
  if (weekday) {
    const offset = ((weekday.index - getMoscowDayIndex() + 7) % 7) || 7;
    rest = rest.replace(new RegExp(`в?\\s*${weekday.key}`, "i"), " ");
    if (explicitTime) rest = rest.replace(/(?:^|\s)в\s*\d{1,2}(?::|\.?)\d{0,2}\b/i, " ");
    return {
      reminderAt: hasTime ? moscowLocalDate(offset, hour, minute) : null,
      hasDate: true,
      hasTime,
      text: compact(rest),
    };
  }

  if (explicitTime) rest = rest.replace(/(?:^|\s)в\s*\d{1,2}(?::|\.?)\d{0,2}\b/i, " ");
  return {
    reminderAt: null,
    hasDate: false,
    hasTime,
    text: compact(rest),
  };
}

export function looksLikeReminderCandidate(message: string): boolean {
  if (isLikelyQuestion(message)) return false;
  if (getKeywordCommand(message)) return false;
  if (/(измени|обнови|перенеси|переименуй|исправь)/i.test(message) || /(удали|удалить|сотри)/i.test(message) || /перемест|перенеси|переименуй/i.test(message)) return false;
  const parsed = parseReminderCommand(message);
  return parsed.hasDate || parsed.hasTime;
}
