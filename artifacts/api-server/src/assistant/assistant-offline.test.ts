import assert from "node:assert/strict";
import test from "node:test";
import { buildOfflineAssistantReply } from "./assistant-offline";

test("offline general reply is short and hides technical details", () => {
  const reply = buildOfflineAssistantReply("что такое транзакция");

  assert.equal(
    reply,
    "Сейчас не удалось подготовить ответ. Попробуйте чуть позже.",
  );
  assert.doesNotMatch(reply, /AI|API|ключ|quota|billing|fallback|я могу/i);
});

test("offline source query returns its deterministic context summary", () => {
  assert.equal(
    buildOfflineAssistantReply(
      "какие у меня напоминания",
      "Ваши напоминания:\n- Защита: 20.06.2026, 09:00",
    ),
    "Ваши напоминания:\n- Защита: 20.06.2026, 09:00",
  );
});
