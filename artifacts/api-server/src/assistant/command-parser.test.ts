import assert from "node:assert/strict";
import test from "node:test";
import {
  getKeywordCommand,
  looksLikeListCandidate,
  looksLikeReminderCandidate,
  parseListCommand,
  parseReminderCommand,
} from "./command-parser";

function commandSummary(input: string) {
  const command = getKeywordCommand(input);
  if (!command) {
    return {
      kind: "chat",
      reminderCandidate: looksLikeReminderCandidate(input),
      listCandidate: looksLikeListCandidate(input),
    };
  }

  if (command.kind === "list") {
    return { kind: "list", parsed: parseListCommand(command.text) };
  }

  if (command.kind === "reminder") {
    return { kind: "reminder", parsed: parseReminderCommand(command.text) };
  }

  return { kind: "note", text: command.text };
}

test("explicit note commands are recognized without AI", () => {
  assert.deepEqual(commandSummary("заметка изучить Java"), { kind: "note", text: "изучить Java" });
  assert.deepEqual(commandSummary("Заметка изучить Java"), { kind: "note", text: "изучить Java" });
  assert.deepEqual(commandSummary("заметка: изучить Java"), { kind: "note", text: "изучить Java" });
  assert.deepEqual(commandSummary("заметка    купить хлеб"), { kind: "note", text: "купить хлеб" });
  assert.deepEqual(commandSummary("создай заметку купить молоко"), { kind: "note", text: "купить молоко" });
  assert.deepEqual(commandSummary("сохрани заметку идея для диплома: добавить раздел про ИИ"), {
    kind: "note",
    text: "идея для диплома: добавить раздел про ИИ",
  });
  assert.deepEqual(commandSummary("запиши: подготовить текст защиты"), {
    kind: "note",
    text: "подготовить текст защиты",
  });
  assert.deepEqual(commandSummary("заметка"), { kind: "note", text: "" });
  assert.deepEqual(commandSummary("заметка список напоминание"), { kind: "note", text: "список напоминание" });
});

test("lists are parsed without AI and ignore empty items", () => {
  assert.deepEqual(commandSummary("список хлеб, молоко, яйца"), {
    kind: "list",
    parsed: { title: "Список", items: ["хлеб", "молоко", "яйца"] },
  });
  assert.deepEqual(commandSummary("СПИСОК хлеб, молоко"), {
    kind: "list",
    parsed: { title: "Список", items: ["хлеб", "молоко"] },
  });
  assert.deepEqual(commandSummary("список: хлеб, молоко"), {
    kind: "list",
    parsed: { title: "Список", items: ["хлеб", "молоко"] },
  });
  assert.deepEqual(commandSummary("список покупки: хлеб, молоко, яйца"), {
    kind: "list",
    parsed: { title: "Покупки", items: ["хлеб", "молоко", "яйца"] },
  });
  assert.deepEqual(commandSummary("список покупки: хлеб\nмолоко\nяйца"), {
    kind: "list",
    parsed: { title: "Покупки", items: ["хлеб", "молоко", "яйца"] },
  });
  assert.deepEqual(commandSummary("создай список дел: сделать презентацию, проверить диплом, подготовить речь"), {
    kind: "list",
    parsed: {
      title: "Список дел",
      items: ["сделать презентацию", "проверить диплом", "подготовить речь"],
    },
  });
  assert.deepEqual(commandSummary("чеклист для защиты: открыть сайт, показать чат, показать файлы"), {
    kind: "list",
    parsed: {
      title: "Для защиты",
      items: ["открыть сайт", "показать чат", "показать файлы"],
    },
  });
  assert.deepEqual(commandSummary("список заметка, напоминание"), {
    kind: "list",
    parsed: { title: "Список", items: ["заметка", "напоминание"] },
  });
  assert.deepEqual(commandSummary("список"), { kind: "list", parsed: null });
  assert.deepEqual(commandSummary("список хлеб,,,, молоко,, яйца"), {
    kind: "list",
    parsed: { title: "Список", items: ["хлеб", "молоко", "яйца"] },
  });
});

function moscowParts(date: Date) {
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

test("reminders parse explicit dates and use default time when time is omitted", () => {
  const haircutCommand = getKeywordCommand("напоминание завтра в 10:00 стрижка");
  assert.equal(haircutCommand?.kind, "reminder");
  const haircut = parseReminderCommand(haircutCommand.text);
  assert.equal(haircut.hasDate, true);
  assert.equal(haircut.hasTime, true);
  assert.equal(haircut.text, "стрижка");
  assert.ok(haircut.reminderAt instanceof Date);

  const birthdayCommand = getKeywordCommand("напоминание 29 июня день рождения у Дани");
  assert.equal(birthdayCommand?.kind, "reminder");
  const birthday = parseReminderCommand(birthdayCommand.text);
  assert.equal(birthday.hasDate, true);
  assert.equal(birthday.hasTime, false);
  assert.equal(birthday.text, "день рождения у Дани");
  assert.ok(birthday.reminderAt instanceof Date);
  assert.deepEqual(
    (({ month, day, hour, minute }) => ({ month, day, hour, minute }))(moscowParts(birthday.reminderAt)),
    { month: 6, day: 29, hour: 9, minute: 0 },
  );

  const birthdayDateAtEndCommand = getKeywordCommand("напоминание день рождения Дани 29 июня");
  assert.equal(birthdayDateAtEndCommand?.kind, "reminder");
  const birthdayDateAtEnd = parseReminderCommand(birthdayDateAtEndCommand.text);
  assert.equal(birthdayDateAtEnd.hasDate, true);
  assert.equal(birthdayDateAtEnd.hasTime, false);
  assert.equal(birthdayDateAtEnd.text, "день рождения Дани");
  assert.ok(birthdayDateAtEnd.reminderAt instanceof Date);
  assert.deepEqual(
    (({ month, day, hour, minute }) => ({ month, day, hour, minute }))(moscowParts(birthdayDateAtEnd.reminderAt)),
    { month: 6, day: 29, hour: 9, minute: 0 },
  );

  const imperativeBirthdayCommand = getKeywordCommand("напомни 29 июня день рождения Дани");
  assert.equal(imperativeBirthdayCommand?.kind, "reminder");
  const imperativeBirthday = parseReminderCommand(imperativeBirthdayCommand.text);
  assert.equal(imperativeBirthday.text, "день рождения Дани");
  assert.ok(imperativeBirthday.reminderAt instanceof Date);

  const createReminderCommand = getKeywordCommand("создай напоминание на 15 мая подготовить презентацию");
  assert.equal(createReminderCommand?.kind, "reminder");
  const createReminder = parseReminderCommand(createReminderCommand.text);
  assert.equal(createReminder.text, "подготовить презентацию");
  assert.ok(createReminder.reminderAt instanceof Date);

  const noDateCommand = getKeywordCommand("напоминание позвонить преподавателю");
  assert.equal(noDateCommand?.kind, "reminder");
  const noDate = parseReminderCommand(noDateCommand.text);
  assert.equal(noDate.hasDate, false);

  const noDateWeirdCommand = getKeywordCommand("напоминание заметка список");
  assert.equal(noDateWeirdCommand?.kind, "reminder");
  const noDateWeird = parseReminderCommand(noDateWeirdCommand.text);
  assert.equal(noDateWeird.hasDate, false);

  const noTimeOrTextCommand = getKeywordCommand("напоминание завтра");
  assert.equal(noTimeOrTextCommand?.kind, "reminder");
  const noTimeOrText = parseReminderCommand(noTimeOrTextCommand.text);
  assert.equal(noTimeOrText.hasDate, true);
  assert.equal(noTimeOrText.hasTime, false);
  assert.equal(noTimeOrText.text, "");
  assert.ok(noTimeOrText.reminderAt instanceof Date);

  const invalidDateCommand = getKeywordCommand("напоминание 32 января купить хлеб");
  assert.equal(invalidDateCommand?.kind, "reminder");
  const invalidDate = parseReminderCommand(invalidDateCommand.text);
  assert.equal(invalidDate.hasDate, false);

  const casedCommand = getKeywordCommand("Напоминание завтра в 10 стрижка");
  assert.equal(casedCommand?.kind, "reminder");
  const cased = parseReminderCommand(casedCommand.text);
  assert.equal(cased.hasDate, true);
  assert.equal(cased.hasTime, true);
  assert.equal(cased.text, "стрижка");
});

test("ordinary and ambiguous messages are not auto-created", () => {
  assert.deepEqual(commandSummary("как лучше изучать Java?"), {
    kind: "chat",
    reminderCandidate: false,
    listCandidate: false,
  });
  assert.deepEqual(commandSummary("завтра в 10 стрижка"), {
    kind: "chat",
    reminderCandidate: true,
    listCandidate: false,
  });
  assert.deepEqual(commandSummary("хлеб, молоко, яйца"), {
    kind: "chat",
    reminderCandidate: false,
    listCandidate: true,
  });
  assert.deepEqual(commandSummary("как создать заметку для изучения Java?"), {
    kind: "chat",
    reminderCandidate: false,
    listCandidate: false,
  });
  assert.deepEqual(commandSummary("мне нужно напоминание завтра в 10 стрижка"), {
    kind: "chat",
    reminderCandidate: true,
    listCandidate: false,
  });
});

test("unsafe or extreme text stays plain parser output", () => {
  assert.deepEqual(commandSummary("заметка <script>alert(1)</script>"), {
    kind: "note",
    text: "<script>alert(1)</script>",
  });

  const longText = `заметка ${"очень длинный текст ".repeat(1000)}`;
  const longResult = getKeywordCommand(longText);
  assert.equal(longResult?.kind, "note");
  assert.ok(longResult.text.length > 1000);

  assert.deepEqual(commandSummary("   "), {
    kind: "chat",
    reminderCandidate: false,
    listCandidate: false,
  });
});
