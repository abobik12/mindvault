import { Router, type IRouter } from "express";
import { eq, and, desc, inArray } from "drizzle-orm";
import { db, conversations, messages, itemsTable, foldersTable } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { ai } from "@workspace/integrations-gemini-ai";
import {
  CreateGeminiConversationBody,
  SendGeminiMessageBody,
  GetGeminiConversationParams,
  DeleteGeminiConversationParams,
  ListGeminiMessagesParams,
  SendGeminiMessageParams,
  ClassifyContentBody,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import {
  formatMoscowDateTime,
  getCurrentMoscowDateTimeForModel,
  parseReminderDateTime,
} from "../lib/time";
import { type UserContextData } from "../lib/ai-context";
import { canAttemptTextExtraction, extractTextFromUpload } from "../lib/file-extraction";
import {
  type AssistantActionContext,
  type AssistantActionIntent,
} from "../assistant/actions";
import { handleAssistantMessage } from "../assistant/assistant-handler";
import type { AssistantActionSelection } from "../assistant/assistant-contract";
import {
  intentUsesPersonalSources,
  selectSourcesUsedInResponse,
} from "../assistant/assistant-sources";
import { buildOfflineAssistantReply } from "../assistant/assistant-offline";
import {
  formatContextLayersForPrompt,
  prepareAssistantContextLayers,
} from "../assistant/assistant-memory";
import { undoAssistantOperation } from "../assistant/assistant-undo";

const router: IRouter = Router();
const AI_TEXT_MODEL =
  process.env.OPENROUTER_API_KEY?.trim()
    ? process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini"
    : process.env.OPENAI_MODEL || "gpt-4.1-mini";
const DEFAULT_CONVERSATION_TITLE = "MindVault Assistant";
const ATTACHMENT_TEXT_LIMIT = 12000;
const DEFAULT_ASSISTANT_SYSTEM_PROMPT = `Ты — ассистент MindVault, персонального рабочего кабинета пользователя.

Твоя задача:
- отвечать дружелюбно и по делу;
- помогать структурировать мысли, заметки и напоминания;
- MindVault — персональная база знаний пользователя: заметки, файлы, папки, напоминания и история чата;
- если тебе передан контекст MindVault, используй его как источник правды и кратко называй источники;
- не выдумывай сохраненные данные и содержимое файлов;
- нельзя говорить "создал", "изменил", "удалил", "перенес", "сохранил" или "готово", если backend-action не подтвердил success;
- если нужно изменить или удалить объект, сначала он должен быть найден в данных пользователя;
- если найдено несколько объектов, попроси уточнить; если объект не найден, честно скажи об этом;
- использовать ясные формулировки на русском языке;
- отвечать только на русском языке;
- не добавлять лишнюю воду;
- не завершать ответ фразами "если хотите, я могу", "могу также" или другими лишними предложениями;
- если вопрос не относится к данным MindVault, не упоминать заметки, файлы и источники пользователя.

Если пользователь что-то сохранил, подтверждай это естественно и кратко.`;

const FUTURE_TIME_SIGNAL_RE =
  /(завтра|послезавтра|через\s+\d+\s*(минут|час|дн|день|дня|дней|недел|месяц|месяца|месяцев)|в\s+(понедельник|вторник|среду|среда|четверг|пятницу|пятница|субботу|суббота|воскресенье)|в\s?\d{1,2}[:.]\d{2}|к\s?\d{1,2}[:.]\d{2}|утром|днем|вечером|ночью)/i;
const FUTURE_ACTION_SIGNAL_RE =
  /(напомни|напомнить|нужно|надо|не\s?забыть|нужно\s+будет|надо\s+будет|буд[уе]т|поздравить|купить|сделать|подготовить|отправить|созвон|встреча)/i;
const EXPLICIT_SAVE_NOTE_RE =
  /(сохрани|сохранить|запиши|записать|добавь\s+заметк|создай\s+заметк|сделай\s+заметк)/i;
const EXPLICIT_SAVE_REMINDER_RE =
  /(напомни|создай\s+напомин|добавь\s+напомин|поставь\s+напомин|установи\s+напомин)/i;
const ACTION_ON_EXISTING_RE =
  /(перемест|перенес|перенеси|переимену|удали|исправь|измени|обнови|отредактируй)/i;
const AMBIGUOUS_REMINDER_RE =
  /(завтра|послезавтра|в\s+(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)|через\s+\d+)/i;

type IntentType =
  | AssistantActionIntent
  | "chat_only"
  | "save_note"
  | "save_reminder"
  | "save_file"
  | "create_list"
  | "action_on_existing";
type ResponseMode = "reply_only" | "saved" | "suggest_actions" | "action_executed";

type ChatAttachment = {
  id: number;
  name: string;
  mimeType: string | null;
  fileSize: number | null;
  folderId: number | null;
  folderName: string | null;
  textPreview: string | null;
  extractionSummary: string | null;
  createdAt: string;
};

type AssistantContext =
  | (Omit<AssistantActionContext, "intentType" | "suggestedActions"> & {
      intentType: IntentType;
      suggestedActions?: Array<"save_note" | "save_reminder" | "create_list" | "ignore">;
    })
  | null;

function looksLikeFutureReminderIntent(content: string): boolean {
  const normalized = content.toLowerCase();
  const hasTimeSignal = FUTURE_TIME_SIGNAL_RE.test(normalized);
  const hasActionSignal = FUTURE_ACTION_SIGNAL_RE.test(normalized);
  return hasTimeSignal && hasActionSignal;
}

function sanitizeAssistantContext(raw: unknown): AssistantContext {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;

  const intentType = source.intentType;
  const responseMode = source.responseMode;
  if (typeof intentType !== "string" || intentType.length > 80) {
    return null;
  }
  if (
    responseMode !== "reply_only" &&
    responseMode !== "saved" &&
    responseMode !== "suggest_actions" &&
    responseMode !== "action_executed"
  ) {
    return null;
  }

  let savedItem: NonNullable<AssistantContext>["savedItem"] = null;
  const rawSavedItem = source.savedItem;
  if (rawSavedItem && typeof rawSavedItem === "object") {
    const item = rawSavedItem as Record<string, unknown>;
    const rawType = item.type;
    const rawId = item.id;
    const rawTitle = item.title;
    if (
      (rawType === "note" || rawType === "file" || rawType === "reminder" || rawType === "list") &&
      typeof rawId === "number" &&
      typeof rawTitle === "string"
    ) {
      savedItem = {
        id: rawId,
        type: rawType,
        title: rawTitle.slice(0, 180),
        folderId: typeof item.folderId === "number" ? item.folderId : null,
        folderName: typeof item.folderName === "string" ? item.folderName.slice(0, 120) : null,
        reminderAt: typeof item.reminderAt === "string" ? item.reminderAt : null,
        content: typeof item.content === "string" ? item.content.slice(0, 12000) : null,
      };
    }
  }

  const rawSuggested = source.suggestedActions;
  const suggestedActions = Array.isArray(rawSuggested)
    ? rawSuggested.filter(
        (entry): entry is "save_note" | "save_reminder" | "create_list" | "ignore" =>
          entry === "save_note" || entry === "save_reminder" || entry === "create_list" || entry === "ignore",
      )
    : undefined;

  return {
    intentType: intentType as IntentType,
    responseMode,
    autoSaved: source.autoSaved === true,
    assistantReply:
      typeof source.assistantReply === "string" && source.assistantReply.trim()
        ? source.assistantReply.trim().slice(0, 3000)
        : undefined,
    savedItem,
    suggestedActions: suggestedActions && suggestedActions.length > 0 ? suggestedActions : undefined,
    pendingAction:
      source.pendingAction && typeof source.pendingAction === "object"
        ? (source.pendingAction as AssistantActionContext["pendingAction"])
        : undefined,
    actionButtons: Array.isArray(source.actionButtons)
      ? (source.actionButtons as NonNullable<
          AssistantActionContext["actionButtons"]
        >)
      : undefined,
    actionResult:
      source.actionResult && typeof source.actionResult === "object"
        ? (source.actionResult as AssistantActionContext["actionResult"])
        : undefined,
    undoAction:
      source.undoAction && typeof source.undoAction === "object"
        ? (source.undoAction as NonNullable<AssistantActionContext>["undoAction"])
        : undefined,
  };
}

function extractFolderMention(content: string, folders: Array<{ id: number; name: string }>) {
  const lower = content.toLowerCase();
  return folders.find((folder) => lower.includes(folder.name.toLowerCase())) ?? null;
}

function detectItemTypeMention(content: string): "note" | "file" | "reminder" | null {
  const lower = content.toLowerCase();
  if (lower.includes("файл")) return "file";
  if (lower.includes("напомин")) return "reminder";
  if (lower.includes("заметк")) return "note";
  return null;
}

async function tryHandleMoveLatestAction({
  content,
  userId,
  folders,
}: {
  content: string;
  userId: number;
  folders: Array<{ id: number; name: string }>;
}): Promise<{ item: typeof itemsTable.$inferSelect; folder: { id: number; name: string } } | null> {
  const lower = content.toLowerCase();
  const asksMove = /(перемест|перенес|перенеси|перемести)/i.test(lower);
  if (!asksMove) return null;

  const targetFolder = extractFolderMention(content, folders);
  if (!targetFolder) return null;

  const mentionedType = detectItemTypeMention(content);
  const isAboutLast = /(последн|последнюю|последний|последнее|мою|мой|мое)/i.test(lower);
  if (!isAboutLast) return null;

  const baseConditions = [eq(itemsTable.userId, userId), eq(itemsTable.status, "active")];
  if (mentionedType) {
    baseConditions.push(eq(itemsTable.type, mentionedType));
  }

  const [latestItem] = await db
    .select()
    .from(itemsTable)
    .where(and(...baseConditions))
    .orderBy(desc(itemsTable.updatedAt))
    .limit(1);

  if (!latestItem) return null;

  const [updatedItem] = await db
    .update(itemsTable)
    .set({ folderId: targetFolder.id })
    .where(and(eq(itemsTable.id, latestItem.id), eq(itemsTable.userId, userId)))
    .returning();

  if (!updatedItem) return null;

  return {
    item: updatedItem,
    folder: targetFolder,
  };
}

function buildOfflineContextSummary(context?: UserContextData): string | null {
  if (!context) return null;

  const lines: string[] = [];
  if (context.relevantSources.length > 0) {
    lines.push("Я нашел в ваших сохраненных данных:");
    for (const source of context.relevantSources.slice(0, 10)) {
      const folder = source.folder ? `, папка: ${source.folder}` : "";
      lines.push(`- [${source.type}] ${source.title}${folder}`);
    }
    return lines.join("\n");
  }

  if (context.queryIntent === "notes" && context.recentNotes.length > 0) {
    lines.push("Ваши заметки:");
    for (const note of context.recentNotes.slice(0, 10)) lines.push(`- ${note.title} (${note.folder})`);
    return lines.join("\n");
  }

  if (context.queryIntent === "files" && context.recentFiles.length > 0) {
    lines.push("Ваши файлы:");
    for (const file of context.recentFiles.slice(0, 10)) lines.push(`- ${file.filename} (${file.folder}, ${file.size})`);
    return lines.join("\n");
  }

  if (context.queryIntent === "folders" && context.folders.length > 0) {
    lines.push("Ваши папки:");
    for (const folder of context.folders.slice(0, 20)) lines.push(`- ${folder.name} (${folder.itemCount} объектов)`);
    return lines.join("\n");
  }

  if (context.queryIntent === "reminders" && context.upcomingReminders.length > 0) {
    lines.push("Ваши напоминания:");
    for (const reminder of context.upcomingReminders.slice(0, 10)) lines.push(`- ${reminder.title}: ${reminder.dueDate}`);
    return lines.join("\n");
  }

  return null;
}

async function getOrCreateDefaultConversation(userId: number) {
  const [existingConversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.userId, userId), eq(conversations.title, DEFAULT_CONVERSATION_TITLE)))
    .orderBy(desc(conversations.createdAt))
    .limit(1);

  if (existingConversation) return existingConversation;

  const [createdConversation] = await db
    .insert(conversations)
    .values({ userId, title: DEFAULT_CONVERSATION_TITLE })
    .returning();

  return createdConversation;
}

function getAttachmentIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];

  const ids = raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const rawId = (entry as Record<string, unknown>).id;
      return typeof rawId === "number" && Number.isInteger(rawId) ? rawId : null;
    })
    .filter((id): id is number => id !== null);

  return Array.from(new Set(ids)).slice(0, 5);
}

async function getValidatedAttachments(userId: number, raw: unknown): Promise<ChatAttachment[]> {
  const ids = getAttachmentIds(raw);
  if (ids.length === 0) return [];

  const files = await db
    .select({
      id: itemsTable.id,
      title: itemsTable.title,
      originalFilename: itemsTable.originalFilename,
      mimeType: itemsTable.mimeType,
      fileSize: itemsTable.fileSize,
      content: itemsTable.content,
      summary: itemsTable.summary,
      fileData: itemsTable.fileData,
      folderId: itemsTable.folderId,
      folderName: foldersTable.name,
      createdAt: itemsTable.createdAt,
    })
    .from(itemsTable)
    .leftJoin(foldersTable, eq(itemsTable.folderId, foldersTable.id))
    .where(and(eq(itemsTable.userId, userId), eq(itemsTable.type, "file"), inArray(itemsTable.id, ids)));

  const attachments: ChatAttachment[] = [];

  for (const file of files) {
    const name = file.originalFilename || file.title;
    let content = file.content;
    let summary = file.summary;

    if (!content?.trim() && file.fileData && canAttemptTextExtraction(name, file.mimeType)) {
      const extraction = await extractTextFromUpload(name, file.mimeType || "application/octet-stream", file.fileData);
      content = extraction.text;
      summary = extraction.summary;
      await db
        .update(itemsTable)
        .set({ content: extraction.text, summary: extraction.summary })
        .where(and(eq(itemsTable.id, file.id), eq(itemsTable.userId, userId), eq(itemsTable.type, "file")));
    }

    attachments.push({
      id: file.id,
      name,
      mimeType: file.mimeType,
      fileSize: file.fileSize,
      folderId: file.folderId,
      folderName: file.folderName,
      textPreview: content ? content.slice(0, ATTACHMENT_TEXT_LIMIT) : null,
      extractionSummary: summary ?? null,
      createdAt: file.createdAt.toISOString(),
    });
  }

  return attachments;
}

function formatAttachmentsForPrompt(attachments: ChatAttachment[]): string {
  if (attachments.length === 0) return "";

  const lines = [
    "",
    "PRIORITY ATTACHED FILE CONTEXT:",
    "The user attached these file(s) to the current message. If the user says this file/document, they mean these attachments. Use this section before older saved data.",
  ];

  for (const attachment of attachments) {
    lines.push(`- File: ${attachment.name}`);
    lines.push(`  ID: ${attachment.id}`);
    lines.push(`  MIME: ${attachment.mimeType || "unknown"}`);
    lines.push(`  Size: ${attachment.fileSize ?? "unknown"} bytes`);
    lines.push(`  Folder: ${attachment.folderName || "none"}`);
    if (attachment.textPreview?.trim()) {
      lines.push("  Extracted text preview:");
      lines.push(attachment.textPreview);
    } else {
      lines.push(
        `  Extracted text preview: unavailable${attachment.extractionSummary ? ` (${attachment.extractionSummary})` : ""}. Do not invent file contents; use only the filename and metadata.`,
      );
    }
  }

  return `\n\n${lines.join("\n")}`;
}

function getAttachmentsFromMetadata(metadata: unknown): ChatAttachment[] {
  if (!metadata || typeof metadata !== "object") return [];
  const rawAttachments = (metadata as Record<string, unknown>).attachments;
  if (!Array.isArray(rawAttachments)) return [];

  return rawAttachments
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const source = entry as Record<string, unknown>;
      if (typeof source.id !== "number" || typeof source.name !== "string") return null;
      return {
        id: source.id,
        name: source.name,
        mimeType: typeof source.mimeType === "string" ? source.mimeType : null,
        fileSize: typeof source.fileSize === "number" ? source.fileSize : null,
        folderId: typeof source.folderId === "number" ? source.folderId : null,
        folderName: typeof source.folderName === "string" ? source.folderName : null,
        textPreview: typeof source.textPreview === "string" ? source.textPreview.slice(0, 2000) : null,
        extractionSummary: typeof source.extractionSummary === "string" ? source.extractionSummary : null,
        createdAt: typeof source.createdAt === "string" ? source.createdAt : "",
      } satisfies ChatAttachment;
    })
    .filter((entry): entry is ChatAttachment => entry !== null);
}

function formatMessageForModel(content: string, metadata: unknown): string {
  const attachments = getAttachmentsFromMetadata(metadata);
  const context = sanitizeAssistantContext(metadata);
  const notes: string[] = [];
  if (attachments.length > 0) {
    notes.push(
      `Прикреплённые файлы: ${attachments
        .map((attachment) => attachment.name)
        .join(", ")}`,
    );
  }
  if (context?.savedItem) {
    notes.push(
      `Связанный объект: [${context.savedItem.type}] id=${context.savedItem.id} «${context.savedItem.title}»${
        context.savedItem.folderName
          ? `, папка «${context.savedItem.folderName}»`
          : ""
      }`,
    );
  }
  return notes.length > 0 ? `${content}\n\n${notes.join("\n")}` : content;
}

function buildAssistantMessageMetadata(
  assistantContext: AssistantContext,
  userContext?: UserContextData,
  responseText = "",
): AssistantContext | (Record<string, unknown> & { sources?: unknown[] }) | null {
  const exposesSources = intentUsesPersonalSources(
    assistantContext?.intentType,
  );
  if (!exposesSources) return assistantContext;

  const sources = selectSourcesUsedInResponse(userContext, responseText).map((source) => ({
      id: source.id ?? null,
      type: source.type,
      title: source.title,
      snippet: source.excerpt.slice(0, 360),
      folderName: source.folderName ?? source.folder ?? null,
      date: source.date ?? null,
      createdAt: source.createdAt ?? null,
      updatedAt: source.updatedAt ?? null,
      score: source.score,
    }));

  if (sources.length === 0) return assistantContext;
  return {
    ...(assistantContext ?? {}),
    sources,
  };
}

async function serializeMessagesForUser(
  userId: number,
  rows: Array<typeof messages.$inferSelect>,
) {
  const [availableItems, availableFolders] = await Promise.all([
    db
      .select({ id: itemsTable.id })
      .from(itemsTable)
      .where(eq(itemsTable.userId, userId)),
    db
      .select({ id: foldersTable.id })
      .from(foldersTable)
      .where(eq(foldersTable.userId, userId)),
  ]);
  const itemIds = new Set(availableItems.map((item) => item.id));
  const folderIds = new Set(availableFolders.map((folder) => folder.id));

  return rows.map((message) => {
    const metadata =
      message.metadata && typeof message.metadata === "object"
        ? { ...message.metadata }
        : null;
    if (metadata && Array.isArray(metadata.sources)) {
      metadata.sources = metadata.sources.filter((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const source = entry as Record<string, unknown>;
        if (source.type === "message") return true;
        if (typeof source.id !== "number") return false;
        return source.type === "folder"
          ? folderIds.has(source.id)
          : itemIds.has(source.id);
      });
    }
    return {
      id: message.id,
      conversationId: message.conversationId,
      role: message.role,
      content: message.content,
      metadata,
      createdAt: message.createdAt.toISOString(),
    };
  });
}

function emptyUserContext(): UserContextData {
  return {
    overview: {
      folderCount: 0,
      noteCount: 0,
      fileCount: 0,
      reminderCount: 0,
      listCount: 0,
    },
    folders: [],
    recentNotes: [],
    recentFiles: [],
    upcomingReminders: [],
    recentLists: [],
    relevantSources: [],
    queryIntent: "general",
    requestedTypes: [],
  };
}

router.get("/gemini/conversations", requireAuth, async (req, res): Promise<void> => {
  const convs = await db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, req.auth!.userId))
    .orderBy(conversations.createdAt);

  res.json(
    convs.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt.toISOString(),
    })),
  );
});

router.post("/gemini/conversations", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateGeminiConversationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const [conversation] = await db
    .insert(conversations)
    .values({
      userId: req.auth!.userId,
      title: parsed.data.title,
    })
    .returning();

  res.status(201).json({
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt.toISOString(),
  });
});

router.post(
  "/gemini/conversations/:conversationId/actions/:operationId/undo",
  requireAuth,
  async (req, res): Promise<void> => {
    const rawConversationId = Array.isArray(req.params.conversationId)
      ? req.params.conversationId[0]
      : req.params.conversationId;
    const operationId = Array.isArray(req.params.operationId)
      ? req.params.operationId[0]
      : req.params.operationId;
    const conversationId = Number.parseInt(rawConversationId ?? "", 10);
    if (!Number.isInteger(conversationId) || !operationId) {
      res.status(400).json({ error: "Некорректные данные запроса" });
      return;
    }

    const [conversation] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.userId, req.auth!.userId),
        ),
      )
      .limit(1);
    if (!conversation) {
      res.status(404).json({ error: "Диалог не найден" });
      return;
    }

    const result = await undoAssistantOperation({
      operationId,
      userId: req.auth!.userId,
      conversationId,
    });
    res.status(result.success ? 200 : 409).json(result);
  },
);

router.get("/gemini/conversations/default", requireAuth, async (req, res): Promise<void> => {
  const conversation = await getOrCreateDefaultConversation(req.auth!.userId);

  const conversationMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(messages.createdAt);

  res.json({
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt.toISOString(),
    messages: await serializeMessagesForUser(
      req.auth!.userId,
      conversationMessages,
    ),
  });
});

router.get("/gemini/conversations/:id", requireAuth, async (req, res): Promise<void> => {
  const params = GetGeminiConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, params.data.id), eq(conversations.userId, req.auth!.userId)))
    .limit(1);

  if (!conversation) {
    res.status(404).json({ error: "Диалог не найден" });
    return;
  }

  const conversationMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(messages.createdAt);

  res.json({
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt.toISOString(),
    messages: await serializeMessagesForUser(
      req.auth!.userId,
      conversationMessages,
    ),
  });
});

router.delete("/gemini/conversations/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteGeminiConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const [deleted] = await db
    .delete(conversations)
    .where(and(eq(conversations.id, params.data.id), eq(conversations.userId, req.auth!.userId)))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Диалог не найден" });
    return;
  }

  res.sendStatus(204);
});

router.delete("/gemini/messages/:id", requireAuth, async (req, res): Promise<void> => {
  const rawMessageId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const messageId = Number.parseInt(rawMessageId ?? "", 10);
  if (!Number.isInteger(messageId)) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const [message] = await db
    .select({ id: messages.id, conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  if (!message) {
    res.status(404).json({ error: "Сообщение не найдено" });
    return;
  }

  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, message.conversationId), eq(conversations.userId, req.auth!.userId)))
    .limit(1);

  if (!conversation) {
    res.status(404).json({ error: "Сообщение не найдено" });
    return;
  }

  await db.delete(messages).where(eq(messages.id, message.id));
  res.sendStatus(204);
});

router.get("/gemini/conversations/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const params = ListGeminiMessagesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, params.data.id), eq(conversations.userId, req.auth!.userId)))
    .limit(1);

  if (!conversation) {
    res.status(404).json({ error: "Диалог не найден" });
    return;
  }

  const conversationMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(messages.createdAt);

  res.json(
    await serializeMessagesForUser(req.auth!.userId, conversationMessages),
  );
});

router.delete("/gemini/conversations/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const params = ListGeminiMessagesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, params.data.id), eq(conversations.userId, req.auth!.userId)))
    .limit(1);

  if (!conversation) {
    res.status(404).json({ error: "Диалог не найден" });
    return;
  }

  await db.delete(messages).where(eq(messages.conversationId, conversation.id));
  res.sendStatus(204);
});

router.post("/gemini/conversations/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const params = SendGeminiMessageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const bodyParsed = SendGeminiMessageBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }
  const rawBody = req.body as Record<string, unknown>;
  const requestedFolderId =
    typeof rawBody.folderId === "number" && Number.isInteger(rawBody.folderId)
      ? rawBody.folderId
      : null;
  const actionSelection: AssistantActionSelection = {
    pendingActionId:
      typeof rawBody.pendingActionId === "string"
        ? rawBody.pendingActionId
        : undefined,
    selectedIntent:
      rawBody.selectedIntent === "create_note" ||
      rawBody.selectedIntent === "create_list" ||
      rawBody.selectedIntent === "create_reminder" ||
      rawBody.selectedIntent === "cancel"
        ? rawBody.selectedIntent
        : undefined,
    selectedItemId:
      typeof rawBody.selectedItemId === "number" &&
      Number.isInteger(rawBody.selectedItemId)
        ? rawBody.selectedItemId
        : undefined,
    confirm: rawBody.confirm === true,
    cancel: rawBody.cancel === true,
  };

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, params.data.id), eq(conversations.userId, req.auth!.userId)))
    .limit(1);

  if (!conversation) {
    res.status(404).json({ error: "Диалог не найден" });
    return;
  }

  if (requestedFolderId !== null) {
    const [requestedFolder] = await db
      .select({ id: foldersTable.id })
      .from(foldersTable)
      .where(and(eq(foldersTable.id, requestedFolderId), eq(foldersTable.userId, req.auth!.userId)))
      .limit(1);

    if (!requestedFolder) {
      res.status(404).json({ error: "Папка не найдена" });
      return;
    }
  }

  const attachments = await getValidatedAttachments(
    req.auth!.userId,
    rawBody.attachments,
  );
  const attachmentMetadata = attachments.length > 0 ? { attachments } : null;
  const attachmentContext = formatAttachmentsForPrompt(attachments);
  const messageForContextSearch = [bodyParsed.data.content, ...attachments.map((attachment) => attachment.name)]
    .filter(Boolean)
    .join(" ");

  if (attachments.length > 0) {
    logger.info(
      {
        userId: req.auth!.userId,
        conversationId: conversation.id,
        attachmentCount: attachments.length,
        attachmentNames: attachments.map((attachment) => attachment.name).join(", "),
        attachmentContextChars: attachmentContext.length,
      },
      "[assistant-context] attached files for chat message",
    );
  }

  await db
    .insert(messages)
    .values({
      conversationId: conversation.id,
      role: "user",
      content: bodyParsed.data.content,
      metadata: attachmentMetadata,
    })
    .returning();

  const contextLayers = await prepareAssistantContextLayers({
    userId: req.auth!.userId,
    conversationId: conversation.id,
    currentMessage: messageForContextSearch,
    model: AI_TEXT_MODEL,
  });

  let assistantContext: AssistantContext = null;
  try {
    const actionResult = await handleAssistantMessage({
      userId: req.auth!.userId,
      conversationId: conversation.id,
      text: bodyParsed.data.content,
      model: AI_TEXT_MODEL,
      folderId: requestedFolderId,
      selection: actionSelection,
      contextLayers,
    });
    assistantContext = actionResult.assistantContext;
  } catch (err) {
    logger.error(
      { err, userId: req.auth!.userId, conversationId: conversation.id },
      "[assistant] message pipeline failed",
    );
    assistantContext = {
      intentType: "unknown_or_ambiguous",
      responseMode: "action_executed",
      assistantReply: "Не удалось выполнить действие: данные не были изменены. Попробуйте ещё раз.",
      savedItem: null,
      actionResult: {
        success: false,
        action: "assistant_pipeline",
        error: "execution_failed",
      },
    };
  }

  const chatHistory = contextLayers.recentMessages;

  const shouldUsePersonalContext = intentUsesPersonalSources(
    assistantContext?.intentType,
  );
  const userContext = shouldUsePersonalContext
    ? contextLayers.userContext
    : emptyUserContext();
  const systemPrompt =
    process.env.ASSISTANT_SYSTEM_PROMPT?.trim() || DEFAULT_ASSISTANT_SYSTEM_PROMPT;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  let fullResponse = "";
  const deterministicReply = assistantContext?.assistantReply?.trim();

  if (assistantContext && deterministicReply && assistantContext.responseMode !== "reply_only") {
    const assistantMessageMetadata = buildAssistantMessageMetadata(
      assistantContext,
      userContext,
      deterministicReply,
    );
    await db.insert(messages).values({
      conversationId: conversation.id,
      role: "assistant",
      content: deterministicReply,
      metadata: assistantMessageMetadata,
    });

    res.write(`data: ${JSON.stringify({ content: deterministicReply })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true, assistantContext })}\n\n`);
    res.end();
    return;
  }

  const contextForPrompt = formatContextLayersForPrompt(contextLayers, {
    includeRelevantObjects: shouldUsePersonalContext,
  });
  logger.info(
    {
      userId: req.auth!.userId,
      conversationId: conversation.id,
      promptContextChars: contextForPrompt.length,
      relevantCount: userContext.relevantSources.length,
      queryIntent: userContext.queryIntent,
    },
    "[assistant-context] attached context to AI prompt",
  );

  const systemPromptWithContext = systemPrompt + contextForPrompt + attachmentContext;
  const currentUserContent = attachmentContext
    ? `${bodyParsed.data.content}${attachmentContext}`
    : bodyParsed.data.content;
  const contentsForGemini = [
    { role: "user" as const, parts: [{ text: systemPromptWithContext }] },
    {
      role: "model" as const,
      parts: [{ text: "Понял задачу. Готов помочь с организацией вашего рабочего пространства." }],
    },
    ...chatHistory.slice(0, -1).map((message) => ({
        role: (message.role === "assistant" ? "model" : "user") as "user" | "model",
        parts: [{ text: formatMessageForModel(message.content, message.metadata) }],
      })),
    { role: "user" as const, parts: [{ text: currentUserContent }] },
  ];

  try {
    const stream = await ai.models.generateContentStream({
      model: AI_TEXT_MODEL,
      contents: contentsForGemini,
      config: { maxOutputTokens: 8192 },
    });

    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
      }
    }
    if (!fullResponse.trim()) {
      throw new Error("empty_stream");
    }

    await db.insert(messages).values({
      conversationId: conversation.id,
      role: "assistant",
      content: fullResponse,
      metadata: buildAssistantMessageMetadata(
        assistantContext,
        userContext,
        fullResponse,
      ),
    });

    if (chatHistory.length <= 2 && conversation.title !== DEFAULT_CONVERSATION_TITLE) {
      const titlePrompt = `Сформируй короткий заголовок диалога (4-6 слов) по сообщению: \"${bodyParsed.data.content.slice(0, 100)}\". Ответь только заголовком, без кавычек.`;
      try {
        const titleResponse = await ai.models.generateContent({
          model: AI_TEXT_MODEL,
          contents: [{ role: "user", parts: [{ text: titlePrompt }] }],
          config: { maxOutputTokens: 50 },
        });
        const newTitle = titleResponse.text?.trim();
        if (newTitle) {
          await db.update(conversations).set({ title: newTitle }).where(eq(conversations.id, conversation.id));
        }
      } catch (err) {
        logger.warn({ err }, "Не удалось автоматически создать заголовок диалога");
      }
    }

    res.write(`data: ${JSON.stringify({ done: true, assistantContext })}\n\n`);
  } catch (err) {
    logger.error(
      {
        err,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
      "Ошибка при стриминге ответа AI-провайдера",
    );

    try {
      const completion = await ai.models.generateContent({
        model: AI_TEXT_MODEL,
        contents: contentsForGemini,
        config: { maxOutputTokens: 8192 },
      });
      const completionText = completion.text?.trim();

      if (completionText) {
        await db.insert(messages).values({
          conversationId: conversation.id,
          role: "assistant",
          content: completionText,
          metadata: buildAssistantMessageMetadata(
            assistantContext,
            userContext,
            completionText,
          ),
        });
        res.write(
          `data: ${JSON.stringify({
            content: completionText,
            replace: fullResponse.length > 0,
          })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ done: true, assistantContext })}\n\n`);
        res.end();
        return;
      }
    } catch (completionErr) {
      logger.error(
        {
          err: completionErr,
          errorMessage:
            completionErr instanceof Error
              ? completionErr.message
              : String(completionErr),
        },
        "Не удалось получить и обычный ответ AI-провайдера",
      );
    }

    const fallbackResponse = buildOfflineAssistantReply(
      attachmentContext ? `${bodyParsed.data.content}${attachmentContext}` : bodyParsed.data.content,
      buildOfflineContextSummary(userContext),
    );
    await db.insert(messages).values({
      conversationId: conversation.id,
      role: "assistant",
      content: fallbackResponse,
      metadata: buildAssistantMessageMetadata(
        assistantContext,
        userContext,
        fallbackResponse,
      ),
    });

    res.write(
      `data: ${JSON.stringify({
        content: fallbackResponse,
        replace: fullResponse.length > 0,
      })}\n\n`,
    );
    res.write(`data: ${JSON.stringify({ done: true, assistantContext })}\n\n`);
  }

  res.end();
});

router.post("/gemini/classify", requireAuth, async (_req, res): Promise<void> => {
  res.status(410).json({
    error: "Отдельная классификация отключена. Отправляйте сообщение через endpoint диалога.",
  });
});
export default router;
