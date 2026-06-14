import assert from "node:assert/strict";
import test from "node:test";
import { assistantIntentSchema } from "./assistant-intent";

test("strict AI intent schema accepts a valid note command", () => {
  const result = assistantIntentSchema.safeParse({
    intent: "create_note",
    confidence: 0.96,
    needsConfirmation: false,
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
    needsConfirmation: false,
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
    confidence: 0.94,
    needsConfirmation: false,
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

