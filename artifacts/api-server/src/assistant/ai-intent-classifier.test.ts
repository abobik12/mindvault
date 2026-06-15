import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClassifierPrompt,
  parseAssistantIntentResponse,
} from "./ai-intent-classifier";

test("classifier rejects invalid JSON without exposing it to the user", () => {
  assert.deepEqual(parseAssistantIntentResponse("{bad json"), {
    status: "invalid",
    reason: "invalid_json",
  });
});

test("classifier prompt contains no confidence threshold or confirmation flag", () => {
  const prompt = buildClassifierPrompt("удали черновик", ["Диплом"]);
  assert.doesNotMatch(prompt, /confidence|needsConfirmation|0\.82/i);
  assert.match(prompt, /backend выполнит его и предложит отмену/i);
});
