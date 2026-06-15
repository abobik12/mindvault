import assert from "node:assert/strict";
import test from "node:test";
import {
  intentUsesPersonalSources,
  selectSourcesUsedInResponse,
  selectVisibleSources,
} from "./assistant-sources";

test("ordinary chat and mutations do not expose personal sources", () => {
  assert.equal(intentUsesPersonalSources("chat_general"), false);
  assert.equal(intentUsesPersonalSources("create_note"), false);
  assert.equal(intentUsesPersonalSources("update_note"), false);
  assert.equal(intentUsesPersonalSources("delete_item"), false);
  assert.equal(intentUsesPersonalSources("move_item_to_folder"), false);
  assert.equal(intentUsesPersonalSources("answer_from_sources"), true);
});

test("used sources exclude relevant candidates not reflected in the answer", () => {
  const context = {
    overview: {
      folderCount: 0,
      noteCount: 2,
      fileCount: 0,
      reminderCount: 0,
      listCount: 0,
    },
    folders: [],
    recentNotes: [],
    recentFiles: [],
    upcomingReminders: [],
    recentLists: [],
    queryIntent: "topic" as const,
    requestedTypes: ["note" as const],
    relevantSources: [
      {
        id: 1,
        type: "note" as const,
        title: "Проверить презентацию",
        excerpt: "Проверить презентацию перед защитой",
        score: 95,
      },
      {
        id: 2,
        type: "note" as const,
        title: "Купить молоко",
        excerpt: "Список продуктов",
        score: 30,
      },
    ],
  };

  const used = selectSourcesUsedInResponse(
    context,
    "В заметке «Проверить презентацию» указано проверить её перед защитой.",
  );
  assert.deepEqual(used.map((source) => source.id), [1]);
});

test("visible sources keep only relevant requested objects", () => {
  const visible = selectVisibleSources({
    overview: {
      folderCount: 1,
      noteCount: 1,
      fileCount: 1,
      reminderCount: 0,
      listCount: 0,
    },
    folders: [],
    recentNotes: [],
    recentFiles: [],
    upcomingReminders: [],
    recentLists: [],
    queryIntent: "topic",
    requestedTypes: ["note", "file"],
    relevantSources: [
      {
        id: 1,
        type: "note",
        title: "Зачет",
        excerpt: "Зачет 20 июня",
        score: 90,
      },
      {
        id: 2,
        type: "file",
        title: "Случайный файл",
        excerpt: "Не относится к вопросу",
        score: 5,
      },
      {
        id: 3,
        type: "folder",
        title: "Учеба",
        excerpt: "Папка",
        score: 80,
      },
    ],
  });

  assert.deepEqual(
    visible.map((source) => source.title),
    ["Зачет"],
  );
});
