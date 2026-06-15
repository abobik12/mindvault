import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??=
  "postgresql://mindvault:mindvault@127.0.0.1:5432/mindvault";

const contextModule = import("./ai-context");

test("topic queries do not include every object of the requested type", async () => {
  const { shouldIncludeCollectionByIntent } = await contextModule;
  assert.equal(
    shouldIncludeCollectionByIntent(
      "что у меня записано про презентацию?",
      "notes",
      "note",
    ),
    false,
  );
});

test("broad collection queries include matching object types", async () => {
  const { shouldIncludeCollectionByIntent } = await contextModule;
  assert.equal(
    shouldIncludeCollectionByIntent(
      "какие у меня ближайшие напоминания?",
      "reminders",
      "reminder",
    ),
    true,
  );
  assert.equal(
    shouldIncludeCollectionByIntent(
      "какие у меня ближайшие напоминания?",
      "reminders",
      "note",
    ),
    false,
  );
});

test("reminder sources expose the due date instead of updatedAt", async () => {
  const { getSourceDisplayDate } = await contextModule;
  const dueAt = new Date("2026-06-29T06:00:00.000Z");
  const updatedAt = new Date("2026-06-15T12:00:00.000Z");
  const result = getSourceDisplayDate("reminder", dueAt, updatedAt);

  assert.match(result, /29/);
  assert.match(result, /09:00/);
  assert.doesNotMatch(result, /15/);
});
