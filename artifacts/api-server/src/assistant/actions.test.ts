import assert from "node:assert/strict";
import test from "node:test";
import { getKeywordCommand } from "./command-parser";

process.env.DATABASE_URL ??= "postgresql://mindvault:mindvault@127.0.0.1:5432/mindvault";

const actionsModule = import("./actions");

function createPersistence() {
  const inserted: Array<Record<string, unknown>> = [];

  return {
    inserted,
    persistence: {
      async insertItem(values: Record<string, any>) {
        inserted.push(values);
        const now = new Date();
        return {
          id: inserted.length,
          userId: values.userId,
          folderId: values.folderId ?? null,
          type: values.type,
          title: values.title,
          content: values.content ?? null,
          summary: values.summary ?? null,
          originalFilename: values.originalFilename ?? null,
          mimeType: values.mimeType ?? null,
          fileSize: values.fileSize ?? null,
          fileData: values.fileData ?? null,
          reminderAt: values.reminderAt ?? null,
          status: values.status ?? "active",
          aiCategory: values.aiCategory ?? null,
          aiTags: values.aiTags ?? [],
          aiConfidence: values.aiConfidence ?? null,
          createdAt: now,
          updatedAt: now,
        };
      },
    },
  };
}

test("action logic persists explicit note and list commands", async () => {
  const { executeKeywordCommand } = await actionsModule;
  const noteCommand = getKeywordCommand("создай заметку купить молоко");
  const listCommand = getKeywordCommand("список продукты: молоко, хлеб, сыр");
  assert.ok(noteCommand);
  assert.ok(listCommand);

  const noteStore = createPersistence();
  const now = new Date();
  const noteResult = await executeKeywordCommand({
    command: noteCommand,
    userId: 42,
    folders: [
      {
        id: 5,
        userId: 42,
        name: "Заметки",
        color: null,
        icon: null,
        isSystem: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    persistence: noteStore.persistence,
  });

  assert.equal(noteStore.inserted.length, 1);
  assert.deepEqual(noteStore.inserted[0], {
    userId: 42,
    type: "note",
    title: "купить молоко",
    content: "купить молоко",
    folderId: 5,
    status: "active",
    aiTags: [],
  });
  assert.equal(noteResult.responseMode, "saved");
  assert.equal(noteResult.assistantContext.actionResult?.success, true);

  const listStore = createPersistence();
  const listResult = await executeKeywordCommand({
    command: listCommand,
    userId: 42,
    folders: [],
    persistence: listStore.persistence,
  });

  assert.equal(listStore.inserted.length, 1);
  assert.equal(listStore.inserted[0].type, "list");
  assert.equal(listStore.inserted[0].title, "Продукты");
  assert.deepEqual(JSON.parse(String(listStore.inserted[0].content)).items.map((item: any) => item.text), [
    "молоко",
    "хлеб",
    "сыр",
  ]);
  assert.equal(listResult.responseMode, "saved");
  assert.equal(listResult.assistantContext.actionResult?.success, true);
});

test("action logic saves a date-only reminder at the default Moscow time", async () => {
  const { executeKeywordCommand } = await actionsModule;
  const command = getKeywordCommand("напоминание день рождения Дани 29 июня");
  assert.ok(command);

  const store = createPersistence();
  const result = await executeKeywordCommand({
    command,
    userId: 7,
    folders: [],
    persistence: store.persistence,
  });

  assert.equal(store.inserted.length, 1);
  assert.equal(store.inserted[0].type, "reminder");
  assert.equal(store.inserted[0].title, "день рождения Дани");
  assert.ok(store.inserted[0].reminderAt instanceof Date);

  const moscowTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(store.inserted[0].reminderAt as Date);
  assert.equal(moscowTime, "09:00");
  assert.equal(result.responseMode, "saved");
  assert.equal(result.assistantContext.actionResult?.success, true);
});

test("action logic does not claim success when a reminder has no date", async () => {
  const { executeKeywordCommand } = await actionsModule;
  const command = getKeywordCommand("напоминание позвонить преподавателю");
  assert.ok(command);

  const store = createPersistence();
  const result = await executeKeywordCommand({
    command,
    userId: 7,
    folders: [],
    persistence: store.persistence,
  });

  assert.equal(store.inserted.length, 0);
  assert.equal(result.responseMode, "action_executed");
  assert.equal(result.assistantContext.actionResult?.success, false);
  assert.equal(result.assistantContext.actionResult?.error, "confirmation_required");
  assert.ok(
    result.assistantContext.pendingAction &&
      "action" in result.assistantContext.pendingAction,
  );
  if (
    result.assistantContext.pendingAction &&
    "action" in result.assistantContext.pendingAction
  ) {
    assert.equal(result.assistantContext.pendingAction.action, "create_reminder");
  }
});

test("validated AI intent persists an idea only after backend insert succeeds", async () => {
  const { executeValidatedAssistantIntent } = await actionsModule;
  const store = createPersistence();

  const result = await executeValidatedAssistantIntent({
    intent: {
      intent: "create_note",
      data: {
        title: "Добавить раздел про ИИ",
        content: "Добавить раздел про ИИ",
        folderName: null,
      },
    },
    userId: 7,
    folders: [],
    persistence: store.persistence,
  });

  assert.equal(store.inserted.length, 1);
  assert.equal(store.inserted[0].type, "note");
  assert.equal(store.inserted[0].content, "Добавить раздел про ИИ");
  assert.equal(result.responseMode, "saved");
  assert.equal(result.assistantContext.actionResult?.success, true);
});

test("validated ordinary chat intent never creates an item", async () => {
  const { executeValidatedAssistantIntent } = await actionsModule;
  const store = createPersistence();

  const result = await executeValidatedAssistantIntent({
    intent: {
      intent: "chat_general",
      data: {},
    },
    userId: 7,
    folders: [],
    persistence: store.persistence,
  });

  assert.equal(store.inserted.length, 0);
  assert.equal(result.handled, false);
  assert.equal(result.responseMode, "reply_only");
});

test("ordinary plan remains chat without confidence-based buttons", async () => {
  const { executeValidatedAssistantIntent } = await actionsModule;
  const store = createPersistence();

  const result = await executeValidatedAssistantIntent({
    intent: {
      intent: "chat_general",
      data: {},
    },
    userId: 7,
    folders: [],
    originalMessage: "нужно будет добавить больше скриншотов",
    persistence: store.persistence,
  });

  assert.equal(store.inserted.length, 0);
  assert.equal(result.handled, false);
  assert.equal(result.responseMode, "reply_only");
  assert.equal(result.assistantContext.actionButtons, undefined);
});

test("cancelled pending action has an explicit cancelled result", async () => {
  const { createCancelledResponse } = await actionsModule;
  const result = createCancelledResponse();

  assert.equal(result.assistantContext.assistantReply, "Действие отменено.");
  assert.equal(result.assistantContext.actionResult?.success, false);
  assert.equal(result.assistantContext.actionResult?.error, "cancelled");
});

test("equally matching targets request textual clarification", async () => {
  const { executeValidatedAssistantIntent } = await actionsModule;
  const now = new Date();
  const makeList = (id: number, title: string) => ({
    id,
    userId: 7,
    folderId: null,
    type: "list" as const,
    title,
    content: JSON.stringify({ kind: "todo-list", items: [] }),
    summary: null,
    originalFilename: null,
    mimeType: null,
    fileSize: null,
    fileData: null,
    reminderAt: null,
    status: "active" as const,
    aiCategory: null,
    aiTags: [],
    aiConfidence: null,
    createdAt: now,
    updatedAt: now,
  });

  const result = await executeValidatedAssistantIntent({
    intent: {
      intent: "update_list",
      data: {
        targetQuery: "продукты",
        addItems: ["сыр"],
      },
    },
    userId: 7,
    originalMessage: "добавь сыр в список продуктов",
    folders: [],
    items: [
      makeList(1, "Продукты на неделю"),
      makeList(2, "Продукты для праздника"),
    ],
  });

  assert.equal(result.responseMode, "action_executed");
  assert.equal(result.assistantContext.actionResult?.success, false);
  assert.equal(result.assistantContext.actionResult?.error, "ambiguous");
  assert.equal(result.assistantContext.actionButtons, undefined);
});

test("list completion marks an item done instead of removing it", async () => {
  const { applyListItemUpdates } = await actionsModule;
  const result = applyListItemUpdates(
    [
      { id: "milk", text: "молоко", done: false },
      { id: "bread", text: "хлеб", done: false },
    ],
    { completeItems: ["молоко"] },
  );

  assert.deepEqual(result, [
    { id: "milk", text: "молоко", done: true },
    { id: "bread", text: "хлеб", done: false },
  ]);
});
