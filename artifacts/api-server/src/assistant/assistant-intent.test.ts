import assert from "node:assert/strict";
import test from "node:test";
import { assistantIntentSchema } from "./assistant-intent";

test("strict AI intent schema accepts a valid note command", () => {
  const result = assistantIntentSchema.safeParse({
    intent: "create_note",
    data: {
      title: "Добавить раздел про ИИ",
      content: "Добавить раздел про ИИ",
      folderName: null,
    },
  });

  assert.equal(result.success, true);
});

test("strict AI intent schema rejects unknown fields and malformed data", () => {
  const result = assistantIntentSchema.safeParse({
    intent: "create_note",
    confidence: 1.2,
    data: {
      title: "Идея",
      content: "Текст",
      unexpected: "must not pass",
    },
  });

  assert.equal(result.success, false);
});

test("reminder intent uses 09:00 when the classifier omits time", () => {
  const result = assistantIntentSchema.parse({
    intent: "create_reminder",
    data: {
      title: "Защита диплома",
      content: "",
      date: "2099-06-29",
      folderName: null,
    },
  });

  assert.equal(result.intent, "create_reminder");
  if (result.intent === "create_reminder") {
    assert.equal(result.data.time, "09:00");
  }
});

test("schema accepts updates and source-based questions", () => {
  const listUpdate = assistantIntentSchema.safeParse({
    intent: "update_list",
    data: {
      targetQuery: "продукты",
      addItems: ["сыр"],
      completeItems: ["молоко"],
    },
  });
  const sourceQuestion = assistantIntentSchema.safeParse({
    intent: "answer_from_sources",
    data: {
      query: "когда зачет",
      types: ["note", "reminder", "file"],
    },
  });

  assert.equal(listUpdate.success, true);
  assert.equal(sourceQuestion.success, true);
});

test("clarify intent contains one short question without action buttons", () => {
  const result = assistantIntentSchema.safeParse({
    intent: "clarify",
    data: { question: "Что именно нужно изменить?" },
  });

  assert.equal(result.success, true);
});

test("intent schema accepts durable memory facts without confidence fields", () => {
  const result = assistantIntentSchema.safeParse({
    intent: "chat_general",
    data: {},
    memory: {
      facts: [
        {
          category: "alias",
          key: "диплом",
          value: "проект выпускной квалификационной работы",
        },
      ],
    },
  });

  assert.equal(result.success, true);
});
