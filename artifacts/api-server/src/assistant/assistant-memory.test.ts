import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??=
  "postgresql://mindvault:mindvault@127.0.0.1:5432/mindvault";

const memoryModule = import("./assistant-memory");

test("memory keeps explicit durable preferences and ignores casual phrases", async () => {
  const { shouldPersistProfileMemory } = await memoryModule;
  assert.equal(
    shouldPersistProfileMemory("Запомни: дипломом я называю проект ВКР"),
    true,
  );
  assert.equal(shouldPersistProfileMemory("Сегодня надо купить молоко"), false);
});

test("profile facts update by category and key without unbounded duplication", async () => {
  const { mergeProfileFacts } = await memoryModule;
  const first = mergeProfileFacts(
    { facts: [] },
    [
      {
        category: "alias",
        key: "диплом",
        value: "проект ВКР",
      },
    ],
    new Date("2026-06-15T10:00:00.000Z"),
  );
  const second = mergeProfileFacts(
    first,
    [
      {
        category: "alias",
        key: "Диплом",
        value: "выпускная квалификационная работа MindVault",
      },
    ],
    new Date("2026-06-15T11:00:00.000Z"),
  );

  assert.equal(second.facts.length, 1);
  assert.equal(second.facts[0].mentions, 2);
  assert.equal(
    second.facts[0].value,
    "выпускная квалификационная работа MindVault",
  );
});
