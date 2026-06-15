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

export const DEFAULT_REMINDER_HOUR = 9;
export const DEFAULT_REMINDER_MINUTE = 0;

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
  const source = message.trim();
  if (!source || isLikelyQuestion(source)) return null;

  const commandPatterns: Array<{
    kind: KeywordCommand["kind"];
    pattern: RegExp;
  }> = [
    {
      kind: "note",
      pattern: /^(?:создай|сделай|сохрани|добавь)\s+(?:новую\s+)?заметку(?=\s|[:：-]|$)[\s:：-]*/i,
    },
    {
      kind: "note",
      pattern:
        /^(?:сохрани|сохранить|запиши|записать)\s+(?:эту\s+)?(?:мысль|идею|информацию)(?=\s|[:：-]|$)[\s:：-]*/i,
    },
    {
      kind: "note",
      pattern: /^запиши(?:\s+(?:как\s+)?заметку)?(?=\s|[:：-]|$)[\s:：-]*/i,
    },
    {
      kind: "note",
      pattern: /^заметка(?=\s|[:：-]|$)[\s:：-]*/i,
    },
    {
      kind: "reminder",
      pattern: /^(?:создай|сделай|добавь|поставь|установи)\s+(?:новое\s+)?напоминание(?=\s|[:：-]|$)[\s:：-]*/i,
    },
    {
      kind: "reminder",
      pattern: /^напомни(?:\s+мне)?(?=\s|[:：-]|$)[\s:：-]*/i,
    },
    {
      kind: "reminder",
      pattern: /^напоминание(?=\s|[:：-]|$)[\s:：-]*/i,
    },
    {
      kind: "reminder",
      pattern: /^не\s+забыть(?=\s|[:：-]|$)[\s:：-]*/i,
    },
    {
      kind: "list",
      pattern: /^(?:создай|сделай|сохрани|добавь)\s+(?:новый\s+)?(?:список|чеклист)(?=\s|[:：-]|$)[\s:：-]*/i,
    },
    {
      kind: "list",
      pattern: /^(?:список|чеклист)(?=\s|[:：-]|$)[\s:：-]*/i,
    },
  ];

  for (const command of commandPatterns) {
    const match = command.pattern.exec(source);
    if (match) {
      return {
        kind: command.kind,
        text: source.slice(match[0].length).trim(),
      } as KeywordCommand;
    }
  }

  return null;
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
    const rawTitle = compact(source.slice(0, colonIndex));
    title = /^дел$/i.test(rawTitle)
      ? "Список дел"
      : capitalizeTitle(titleFromText(rawTitle, "Список"));
    itemsSource = source.slice(colonIndex + 1);
  } else if (/^купить(?=\s|$)/i.test(source)) {
    title = "Покупки";
    itemsSource = source.replace(/^купить(?=\s|$)/i, "");
  } else {
    const productList = /^(продукты|покупки)\s+(.+)$/i.exec(source);
    if (productList) {
      title = capitalizeTitle(productList[1]);
      itemsSource = productList[2].trim().replace(/\s+/g, ", ");
    } else {
      const actionVerbs =
        "(?:открыть|показать|проверить|подготовить|запустить|продемонстрировать)";
      const checklist = new RegExp(
        `^для\\s+(.+?)\\s+(${actionVerbs}(?=\\s|$).+)$`,
        "i",
      ).exec(source);
      if (checklist) {
        title = `Для ${compact(checklist[1])}`;
        itemsSource = checklist[2].replace(
          new RegExp(`\\s+(?=${actionVerbs}(?=\\s|$))`, "gi"),
          ", ",
        );
      }
    }
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

function moscowDateFromParts(day: number, month: number, year: number | null, hour = DEFAULT_REMINDER_HOUR, minute = DEFAULT_REMINDER_MINUTE): Date | null {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  const now = getMoscowParts();
  let targetYear = year ?? now.year;

  const build = (selectedYear: number) => {
    const utc = Date.UTC(selectedYear, month - 1, day, hour - 3, minute, 0, 0);
    const date = new Date(utc);
    const parts = getMoscowParts(date);
    if (parts.year !== selectedYear || parts.month !== month || parts.day !== day) return null;
    return date;
  };

  let result = build(targetYear);
  if (!result) return null;

  if (year === null) {
    const isPast =
      targetYear < now.year ||
      (targetYear === now.year &&
        (month < now.month || (month === now.month && day < now.day)));
    if (isPast) {
      targetYear += 1;
      result = build(targetYear);
    }
  }

  return result;
}

function cleanReminderText(value: string): string {
  return compact(value).replace(/^на\s+/i, "");
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
      text: cleanReminderText(rest),
    };
  }

  const explicitTime = /(?:^|\s)в\s*(\d{1,2})(?::|\.?)(\d{2})?\b/i.exec(text);
  const hasTime = Boolean(explicitTime);
  const hour = explicitTime ? Number(explicitTime[1]) : DEFAULT_REMINDER_HOUR;
  const minute = explicitTime?.[2] ? Number(explicitTime[2]) : DEFAULT_REMINDER_MINUTE;
  const hasValidTime = hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;

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
      reminderAt: hasValidTime ? moscowLocalDate(dayOffset, hour, minute) : null,
      hasDate: true,
      hasTime,
      text: cleanReminderText(rest),
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
      reminderAt: hasValidTime ? moscowLocalDate(offset, hour, minute) : null,
      hasDate: true,
      hasTime,
      text: cleanReminderText(rest),
    };
  }

  const monthNames: Record<string, number> = {
    января: 1,
    январь: 1,
    февраля: 2,
    февраль: 2,
    марта: 3,
    март: 3,
    апреля: 4,
    апрель: 4,
    мая: 5,
    май: 5,
    июня: 6,
    июнь: 6,
    июля: 7,
    июль: 7,
    августа: 8,
    август: 8,
    сентября: 9,
    сентябрь: 9,
    октября: 10,
    октябрь: 10,
    ноября: 11,
    ноябрь: 11,
    декабря: 12,
    декабрь: 12,
  };
  const monthNamePattern = Object.keys(monthNames).join("|");
  const namedDate = new RegExp(`(?:^|\\s)(\\d{1,2})\\s+(${monthNamePattern})(?:\\s+(\\d{4}))?(?=\\s|$)`, "i").exec(normalized);
  if (namedDate) {
    const day = Number(namedDate[1]);
    const month = monthNames[namedDate[2]];
    const year = namedDate[3] ? Number(namedDate[3]) : null;
    const reminderAt = moscowDateFromParts(day, month, year, hour, minute);
    if (reminderAt) {
      rest = rest.replace(new RegExp(`(^|\\s)${day}\\s+${namedDate[2]}(?:\\s+${namedDate[3]})?(?=\\s|$)`, "i"), " ");
      if (explicitTime) rest = rest.replace(/(?:^|\s)в\s*\d{1,2}(?::|\.?)\d{0,2}\b/i, " ");
      return {
        reminderAt,
        hasDate: true,
        hasTime,
        text: cleanReminderText(rest),
      };
    }
  }

  const numericDate = /(?:^|\s)(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?=\s|$)/.exec(normalized);
  if (numericDate) {
    const day = Number(numericDate[1]);
    const month = Number(numericDate[2]);
    const rawYear = numericDate[3];
    const year = rawYear ? Number(rawYear.length === 2 ? `20${rawYear}` : rawYear) : null;
    const reminderAt = moscowDateFromParts(day, month, year, hour, minute);
    if (reminderAt) {
      rest = rest.replace(/\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b/i, " ");
      if (explicitTime) rest = rest.replace(/(?:^|\s)в\s*\d{1,2}(?::|\.?)\d{0,2}\b/i, " ");
      return {
        reminderAt,
        hasDate: true,
        hasTime,
        text: cleanReminderText(rest),
      };
    }
  }

  if (explicitTime) rest = rest.replace(/(?:^|\s)в\s*\d{1,2}(?::|\.?)\d{0,2}\b/i, " ");
  return {
    reminderAt: null,
    hasDate: false,
    hasTime,
    text: cleanReminderText(rest),
  };
}

export function looksLikeReminderCandidate(message: string): boolean {
  if (isLikelyQuestion(message)) return false;
  if (getKeywordCommand(message)) return false;
  if (/(измени|обнови|перенеси|переименуй|исправь)/i.test(message) || /(удали|удалить|сотри)/i.test(message) || /перемест|перенеси|переименуй/i.test(message)) return false;
  const parsed = parseReminderCommand(message);
  return parsed.hasDate || parsed.hasTime;
}
