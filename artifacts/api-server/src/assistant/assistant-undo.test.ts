import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??=
  "postgresql://mindvault:mindvault@127.0.0.1:5432/mindvault";

const undoModule = import("./assistant-undo");

test("undo diff records only created, updated and deleted rows", async () => {
  const { diffAssistantSnapshots } = await undoModule;
  const changes = diffAssistantSnapshots(
    {
      items: [
        { id: 1, title: "До", userId: 7 },
        { id: 2, title: "Удалить", userId: 7 },
      ],
      folders: [{ id: 3, name: "Старая", userId: 7 }],
    },
    {
      items: [
        { id: 1, title: "После", userId: 7 },
        { id: 4, title: "Создано", userId: 7 },
      ],
      folders: [{ id: 3, name: "Старая", userId: 7 }],
    },
  );

  assert.deepEqual(
    changes.map((change) => [change.entity, change.kind, change.before?.id, change.after?.id]),
    [
      ["item", "update", 1, 1],
      ["item", "delete", 2, undefined],
      ["item", "create", undefined, 4],
    ],
  );
});
