import { and, desc, eq } from "drizzle-orm";
import { conversations, db, foldersTable, itemsTable, messages } from "@workspace/db";
import { formatMoscowDateTime, parseReminderDateTime } from "../lib/time";
import { logger } from "../lib/logger";

export type AssistantActionIntent =
  | "chat_general"
  | "search_user_content"
  | "answer_about_user_content"
  | "create_note"
  | "update_note"
  | "delete_note"
  | "create_reminder"
  | "update_reminder"
  | "delete_reminder"
  | "search_reminders"
  | "search_files"
  | "answer_about_file"
  | "move_item_to_folder"
  | "create_folder"
  | "rename_folder"
  | "delete_folder"
  | "save_message_as_note"
  | "clear_chat"
  | "unknown_or_ambiguous";

export type AssistantActionContext = {
  intentType: AssistantActionIntent;
  responseMode: "reply_only" | "saved" | "suggest_actions" | "action_executed";
  autoSaved?: boolean;
  assistantReply?: string;
  savedItem?: {
    id: number;
    type: "note" | "file" | "reminder";
    title: string;
    folderId: number | null;
    folderName: string | null;
    reminderAt?: string | null;
  } | null;
  suggestedActions?: Array<"save_note" | "save_reminder" | "ignore">;
  pendingAction?: PendingAction;
  actionResult?: {
    success: boolean;
    action: string;
    error?: string;
  };
};

export type AssistantActionResponse = {
  handled: boolean;
  type: "note" | "reminder" | "file" | "folder" | "chat";
  intentType: AssistantActionIntent;
  responseMode: AssistantActionContext["responseMode"];
  shouldSave: boolean;
  title: string | null;
  summary: string | null;
  cleanedContent: string | null;
  suggestedFolder: string | null;
  tags: string[];
  confidence: number;
  reminderAt: string | null;
  savedItem: Record<string, unknown> | null;
  suggestedActions: Array<"save_note" | "save_reminder" | "ignore">;
  assistantContext: AssistantActionContext;
  message: string;
};

type PendingAction =
  | {
      action: "delete_item";
      itemId: number;
      itemType: "note" | "file" | "reminder";
      title: string;
    }
  | {
      action: "delete_folder";
      folderId: number;
      title: string;
    }
  | {
      action: "clear_chat";
      conversationId: number;
    };

type ItemRecord = typeof itemsTable.$inferSelect;
type FolderRecord = typeof foldersTable.$inferSelect;

const NOTE_WORD_RE = /(заметк|запис|иде[яюи])/i;
const FILE_WORD_RE = /(файл|документ|вложен|презентац|pdf|docx|pptx|txt|md|csv)/i;
const REMINDER_WORD_RE = /(напомин|дедлайн|срок|задач|не\s+забыть)/i;
const FOLDER_WORD_RE = /(папк|раздел|каталог)/i;
const SEARCH_RE = /(какие|покажи|найди|что\s+у\s+меня|что\s+я\s+сохранял|список|перечисли)/i;
const CREATE_NOTE_RE = /(сохрани|создай|добавь|запиши).{0,40}(заметк|запис|иде)|^идея\s*[:：-]/i;
const CREATE_REMINDER_RE = /(напомни|создай\s+напомин|поставь\s+напомин|добавь\s+напомин|не\s+забыть)/i;
const UPDATE_RE = /(измени|обнови|перенеси|переименуй|исправь)/i;
const DELETE_RE = /(удали|удалить|сотри)/i;
const CONFIRM_RE = /^(да|подтверждаю|удали|удаляй|очисти|очищай|точно|ок|хорошо)$/i;
const CANCEL_RE = /^(нет|отмена|отмени|не надо|не удаляй|стоп|cancel)$/i;

function baseResponse(intentType: AssistantActionIntent, message: string): AssistantActionResponse {
  return {
    handled: true,
    type: "chat",
    intentType,
    responseMode: "action_executed",
    shouldSave: false,
    title: null,
    summary: null,
    cleanedContent: null,
    suggestedFolder: null,
    tags: [],
    confidence: 0.9,
    reminderAt: null,
    savedItem: null,
    suggestedActions: [],
    assistantContext: {
      intentType,
      responseMode: "action_executed",
      assistantReply: message,
      savedItem: null,
      actionResult: { success: true, action: intentType },
    },
    message,
  };
}

function chatResponse(): AssistantActionResponse {
  return {
    ...baseResponse("chat_general", "Понял запрос. Отвечаю в чате без автоматического сохранения."),
    handled: false,
    responseMode: "reply_only",
    confidence: 0.65,
    assistantContext: {
      intentType: "chat_general",
      responseMode: "reply_only",
      assistantReply: "Понял запрос. Отвечаю в чате без автоматического сохранения.",
      savedItem: null,
    },
  };
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function titleFromText(value: string, fallback: string): string {
  const normalized = compact(value);
  if (!normalized) return fallback;
  return normalized.length > 90 ? `${normalized.slice(0, 87)}...` : normalized;
}

function itemTitle(item: ItemRecord): string {
  return item.type === "file" ? item.originalFilename || item.title : item.title;
}

function folderNameFor(item: ItemRecord, folders: FolderRecord[]): string | null {
  if (!item.folderId) return null;
  return folders.find((folder) => folder.id === item.folderId)?.name ?? null;
}

function savedItemFromRecord(item: ItemRecord, folders: FolderRecord[]) {
  return {
    id: item.id,
    type: item.type,
    title: itemTitle(item),
    folderId: item.folderId ?? null,
    folderName: folderNameFor(item, folders),
    reminderAt: item.reminderAt ? item.reminderAt.toISOString() : null,
  };
}

function itemResponse(item: ItemRecord, folders: FolderRecord[]) {
  return {
    id: item.id,
    userId: item.userId,
    folderId: item.folderId ?? null,
    folderName: folderNameFor(item, folders),
    type: item.type,
    title: item.title,
    content: item.content ?? null,
    originalFilename: item.originalFilename ?? null,
    mimeType: item.mimeType ?? null,
    fileSize: item.fileSize ?? null,
    reminderAt: item.reminderAt ? item.reminderAt.toISOString() : null,
    status: item.status,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

function extractFolderName(message: string): string | null {
  const match = /(?:в|из|к)\s+папк[уеуи]?\s+["«]?([^"».,!?]+)["»]?/i.exec(message);
  return compact(match?.[1] ?? "") || null;
}

function stripFolderMention(message: string): string {
  return compact(message.replace(/(?:в|из|к)\s+папк[уеуи]?\s+["«]?([^"».,!?]+)["»]?/i, ""));
}

function extractBetween(message: string, left: RegExp, right: RegExp): string | null {
  const leftMatch = left.exec(message);
  const rightMatch = right.exec(message);
  if (!leftMatch || !rightMatch || rightMatch.index <= leftMatch.index) return null;
  return compact(message.slice(leftMatch.index + leftMatch[0].length, rightMatch.index));
}

function extractTarget(message: string, type: "note" | "file" | "reminder" | "folder" | "item"): string {
  const quoted = /[«"]([^»"]+)[»"]/.exec(message)?.[1];
  if (quoted) return compact(quoted);

  if (type === "folder") {
    const folder = /папк[ауи]?\s+([^.,!?]+?)(?:\s+в\s+|$)/i.exec(message)?.[1];
    return compact(folder ?? "");
  }

  const typeWords =
    type === "note"
      ? "(?:заметк[ауие]?|запис[ьи]?)"
      : type === "file"
        ? "(?:файл|документ)"
        : type === "reminder"
          ? "(?:напоминание|напоминалку)"
          : "(?:объект|элемент|это)";

  const re = new RegExp(`${typeWords}\\s+(?:про\\s+)?([^.,!?]+?)(?:\\s+в\\s+папк|\\s+на\\s+|$)`, "i");
  const match = re.exec(message)?.[1];
  return compact(match ?? "");
}

function extractCreateContent(message: string, fallback: string): string {
  const afterColon = /[:：]\s*(.+)$/s.exec(message)?.[1];
  if (afterColon) return compact(afterColon);

  return compact(
    message
      .replace(/^(сохрани|создай|добавь|запиши)\s+/i, "")
      .replace(/^(напомни|не\s+забыть)\s+/i, "")
      .replace(/^(заметку|напоминание)\s*/i, "")
      .replace(/^что\s+/i, ""),
  ) || fallback;
}

function getMoscowParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(pick("year")),
    month: Number(pick("month")),
    day: Number(pick("day")),
    hour: Number(pick("hour")),
    minute: Number(pick("minute")),
  };
}

function moscowLocalDate(dayOffset = 0, hour = 9, minute = 0): Date {
  const parts = getMoscowParts();
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset, hour - 3, minute, 0, 0);
  return new Date(utc);
}

function extractTime(message: string): { hour: number; minute: number } | null {
  const timeMatch = /(?:в|к|на)?\s*(\d{1,2})(?::|\.)(\d{2})/.exec(message);
  if (timeMatch) {
    return { hour: Number(timeMatch[1]), minute: Number(timeMatch[2]) };
  }

  const hourMatch = /(?:в|к|на)\s*(\d{1,2})\s*(?:час(?:ов|а)?|утра|вечера|дня)?/i.exec(message);
  if (!hourMatch) return null;
  let hour = Number(hourMatch[1]);
  if (/вечера/i.test(hourMatch[0]) && hour < 12) hour += 12;
  return { hour, minute: 0 };
}

function parseRussianDateTime(message: string): Date | null {
  const normalized = normalizeText(message);
  const time = extractTime(message) ?? { hour: 9, minute: 0 };

  if (normalized.includes("послезавтра")) return moscowLocalDate(2, time.hour, time.minute);
  if (normalized.includes("завтра")) return moscowLocalDate(1, time.hour, time.minute);
  if (normalized.includes("сегодня")) return moscowLocalDate(0, time.hour, time.minute);

  const isoDate = /(\d{4})-(\d{2})-(\d{2})/.exec(message);
  if (isoDate) return parseReminderDateTime(`${isoDate[1]}-${isoDate[2]}-${isoDate[3]}T${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`);

  const dayMonth = /(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/.exec(message);
  if (dayMonth) {
    const now = getMoscowParts();
    const year = dayMonth[3] ? Number(dayMonth[3].length === 2 ? `20${dayMonth[3]}` : dayMonth[3]) : now.year;
    return parseReminderDateTime(`${year}-${dayMonth[2].padStart(2, "0")}-${dayMonth[1].padStart(2, "0")}T${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`);
  }

  if (/(понедельник|вторник|сред|четверг|пятниц|суббот|воскресен)/i.test(normalized)) {
    const weekdays = ["воскрес", "понедельник", "вторник", "сред", "четверг", "пятниц", "суббот"];
    const current = new Date();
    const moscowDay = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Moscow", weekday: "short" })
        .formatToParts(current)
        .find((part) => part.type === "weekday")?.value,
    );
    const currentDay = Number.isNaN(moscowDay) ? current.getUTCDay() : current.getUTCDay();
    const target = weekdays.findIndex((entry) => normalized.includes(entry));
    const offset = target >= 0 ? ((target - currentDay + 7) % 7 || 7) : 0;
    return moscowLocalDate(offset, time.hour, time.minute);
  }

  return null;
}

function removeDateWords(message: string): string {
  return compact(
    message
      .replace(/послезавтра|завтра|сегодня/gi, "")
      .replace(/(?:в|к|на)?\s*\d{1,2}(?::|\.)\d{2}/g, "")
      .replace(/(?:в|к|на)\s*\d{1,2}\s*(?:час(?:ов|а)?|утра|вечера|дня)?/gi, "")
      .replace(/\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?/g, "")
      .replace(/в\s+(понедельник|вторник|среду|среда|четверг|пятницу|пятница|субботу|суббота|воскресенье)/gi, ""),
  );
}

function findFolder(folders: FolderRecord[], name: string | null): FolderRecord | null {
  if (!name) return null;
  const normalized = normalizeText(name);
  return (
    folders.find((folder) => normalizeText(folder.name) === normalized) ??
    folders.find((folder) => normalizeText(folder.name).includes(normalized) || normalized.includes(normalizeText(folder.name))) ??
    null
  );
}

function searchItems(items: ItemRecord[], query: string, type?: "note" | "file" | "reminder"): ItemRecord[] {
  const normalized = normalizeText(query);
  const terms = normalized.split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 2);
  const filtered = type ? items.filter((item) => item.type === type) : items;
  if (!normalized) return filtered.slice(0, 10);

  return filtered
    .map((item) => {
      const haystack = normalizeText(
        [
          item.title,
          item.content ?? "",
          item.summary ?? "",
          item.originalFilename ?? "",
          item.aiCategory ?? "",
          Array.isArray(item.aiTags) ? item.aiTags.join(" ") : "",
        ].join(" "),
      );
      const score =
        (haystack.includes(normalized) ? 100 : 0) +
        terms.reduce((sum, term) => sum + (haystack.includes(term) ? 10 : 0), 0);
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item)
    .slice(0, 10);
}

function listItemsMessage(title: string, items: ItemRecord[], folders: FolderRecord[]): string {
  if (items.length === 0) return `${title}: ничего не найдено.`;
  return [
    `${title}:`,
    ...items.slice(0, 20).map((item, index) => {
      const folder = folderNameFor(item, folders);
      const extra =
        item.type === "reminder" && item.reminderAt
          ? `, ${formatMoscowDateTime(item.reminderAt)}`
          : item.type === "file"
            ? `, ${item.mimeType ?? "file"}`
            : "";
      return `${index + 1}. ${itemTitle(item)}${folder ? ` (${folder}${extra})` : extra ? ` (${extra.slice(2)})` : ""}`;
    }),
  ].join("\n");
}

async function getLatestPendingAction(conversationId: number | null | undefined): Promise<PendingAction | null> {
  if (!conversationId) return null;
  const rows = await db
    .select({ metadata: messages.metadata, role: messages.role })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(6);

  for (const row of rows) {
    if (row.role !== "assistant") continue;
    if (!row.metadata || typeof row.metadata !== "object") return null;
    const pendingAction = (row.metadata as Record<string, unknown>).pendingAction;
    if (pendingAction && typeof pendingAction === "object" && "action" in pendingAction) {
      return pendingAction as PendingAction;
    }
    return null;
  }
  return null;
}

async function executePendingAction(userId: number, action: PendingAction, folders: FolderRecord[]): Promise<AssistantActionResponse> {
  if (action.action === "delete_item") {
    const [deleted] = await db
      .delete(itemsTable)
      .where(and(eq(itemsTable.id, action.itemId), eq(itemsTable.userId, userId), eq(itemsTable.type, action.itemType)))
      .returning();

    if (!deleted) {
      const message = `Не удалось удалить: объект «${action.title}» уже не найден.`;
      return {
        ...baseResponse(`delete_${action.itemType}` as AssistantActionIntent, message),
        assistantContext: {
          intentType: `delete_${action.itemType}` as AssistantActionIntent,
          responseMode: "action_executed",
          assistantReply: message,
          savedItem: null,
          actionResult: { success: false, action: "delete_item", error: "not_found" },
        },
      };
    }

    const message = `Готово: удалил ${action.itemType === "note" ? "заметку" : action.itemType === "file" ? "файл" : "напоминание"} «${itemTitle(deleted)}».`;
    return baseResponse(`delete_${action.itemType}` as AssistantActionIntent, message);
  }

  if (action.action === "delete_folder") {
    const [folder] = await db
      .select()
      .from(foldersTable)
      .where(and(eq(foldersTable.id, action.folderId), eq(foldersTable.userId, userId)))
      .limit(1);

    if (!folder || folder.isSystem) {
      const message = `Не удалось удалить папку «${action.title}»: папка не найдена или является системной.`;
      return {
        ...baseResponse("delete_folder", message),
        assistantContext: {
          intentType: "delete_folder",
          responseMode: "action_executed",
          assistantReply: message,
          savedItem: null,
          actionResult: { success: false, action: "delete_folder", error: "not_found_or_system" },
        },
      };
    }

    await db.transaction(async (tx) => {
      await tx.update(itemsTable).set({ folderId: null }).where(and(eq(itemsTable.folderId, folder.id), eq(itemsTable.userId, userId)));
      await tx.delete(foldersTable).where(and(eq(foldersTable.id, folder.id), eq(foldersTable.userId, userId)));
    });
    return baseResponse("delete_folder", `Готово: удалил папку «${folder.name}». Материалы из неё остались без папки.`);
  }

  await db.delete(messages).where(eq(messages.conversationId, action.conversationId));
  return baseResponse("clear_chat", "Готово: история чата очищена. Заметки, файлы, папки и напоминания не тронуты.");
}

function withPending(intent: AssistantActionIntent, message: string, pendingAction: PendingAction): AssistantActionResponse {
  return {
    ...baseResponse(intent, message),
    responseMode: "action_executed",
    assistantContext: {
      intentType: intent,
      responseMode: "action_executed",
      assistantReply: message,
      savedItem: null,
      pendingAction,
      actionResult: { success: false, action: pendingAction.action, error: "confirmation_required" },
    },
  };
}

export async function classifyAndExecuteAssistantAction({
  userId,
  content,
  conversationId,
  folderId,
}: {
  userId: number;
  content: string;
  conversationId?: number | null;
  folderId?: number | null;
}): Promise<AssistantActionResponse> {
  const normalized = normalizeText(content);
  const folders = await db.select().from(foldersTable).where(eq(foldersTable.userId, userId));
  const items = await db
    .select()
    .from(itemsTable)
    .where(and(eq(itemsTable.userId, userId), eq(itemsTable.status, "active")))
    .orderBy(desc(itemsTable.updatedAt))
    .limit(1000);

  const logBase = { userId, conversationId, contentPreview: content.slice(0, 120) };

  const pending = await getLatestPendingAction(conversationId);
  if (pending && CONFIRM_RE.test(normalized)) {
    logger.info({ ...logBase, intent: pending.action }, "[assistant] executing confirmed pending action");
    return executePendingAction(userId, pending, folders);
  }
  if (pending && CANCEL_RE.test(normalized)) {
    logger.info({ ...logBase, intent: pending.action }, "[assistant] pending action cancelled");
    return baseResponse("unknown_or_ambiguous", "Ок, действие отменено.");
  }

  if (/очисти\s+(чат|историю)|удали\s+историю\s+чата/i.test(normalized)) {
    if (!conversationId) return baseResponse("clear_chat", "Не удалось очистить чат: текущий чат не найден.");
    return withPending(
      "clear_chat",
      "Очистить историю чата? Это удалит только сообщения, заметки/файлы/папки/напоминания останутся. Ответьте «да», чтобы подтвердить.",
      { action: "clear_chat", conversationId },
    );
  }

  if (SEARCH_RE.test(normalized)) {
    if (NOTE_WORD_RE.test(normalized)) {
      const notes = items.filter((item) => item.type === "note");
      return baseResponse("search_user_content", listItemsMessage("Ваши заметки", notes, folders));
    }
    if (FILE_WORD_RE.test(normalized)) {
      const files = items.filter((item) => item.type === "file");
      return baseResponse("search_files", listItemsMessage("Ваши файлы", files, folders));
    }
    if (REMINDER_WORD_RE.test(normalized)) {
      const reminders = items.filter((item) => item.type === "reminder");
      return baseResponse("search_reminders", listItemsMessage("Ваши напоминания", reminders, folders));
    }
    if (FOLDER_WORD_RE.test(normalized)) {
      const message =
        folders.length === 0
          ? "У вас пока нет папок."
          : ["Ваши папки:", ...folders.map((folder, index) => `${index + 1}. ${folder.name}`)].join("\n");
      return baseResponse("search_user_content", message);
    }
  }

  if (/создай\s+папк|добавь\s+папк/i.test(normalized)) {
    const folderName = extractTarget(content, "folder") || compact(content.replace(/создай|добавь|папк[ауи]?/gi, ""));
    if (!folderName) return baseResponse("unknown_or_ambiguous", "Как назвать новую папку?");
    const existing = findFolder(folders, folderName);
    if (existing) return baseResponse("create_folder", `Папка «${existing.name}» уже есть.`);
    const [folder] = await db.insert(foldersTable).values({ userId, name: folderName, isSystem: false }).returning();
    logger.info({ ...logBase, intent: "create_folder", folderId: folder.id }, "[assistant] action success");
    return baseResponse("create_folder", `Готово: создал папку «${folder.name}».`);
  }

  if (/переименуй\s+папк|измени\s+название\s+папк/i.test(normalized)) {
    const oldName = extractBetween(content, /папк[ауи]?\s+/i, /\s+(?:в|на)\s+/i);
    const newName = /(?:в|на)\s+["«]?([^"».,!?]+)["»]?/i.exec(content)?.[1];
    const folder = findFolder(folders, oldName);
    if (!folder) return baseResponse("rename_folder", `Я не нашел папку${oldName ? ` «${oldName}»` : ""}.`);
    if (folder.isSystem) return baseResponse("rename_folder", "Системные папки нельзя переименовывать.");
    if (!newName) return baseResponse("rename_folder", `Как назвать папку «${folder.name}»?`);
    const [updated] = await db.update(foldersTable).set({ name: compact(newName) }).where(and(eq(foldersTable.id, folder.id), eq(foldersTable.userId, userId))).returning();
    return baseResponse("rename_folder", `Готово: переименовал папку «${folder.name}» в «${updated.name}».`);
  }

  if (DELETE_RE.test(normalized) && FOLDER_WORD_RE.test(normalized)) {
    const target = extractTarget(content, "folder");
    const folder = findFolder(folders, target);
    if (!folder) return baseResponse("delete_folder", `Я не нашел папку${target ? ` «${target}»` : ""}.`);
    if (folder.isSystem) return baseResponse("delete_folder", "Системные папки нельзя удалять.");
    return withPending(
      "delete_folder",
      `Удалить папку «${folder.name}»? Материалы из неё останутся без папки. Ответьте «да», чтобы подтвердить.`,
      { action: "delete_folder", folderId: folder.id, title: folder.name },
    );
  }

  if (CREATE_NOTE_RE.test(normalized)) {
    const folder = findFolder(folders, extractFolderName(content)) ?? (folderId ? folders.find((entry) => entry.id === folderId) ?? null : null);
    const text = stripFolderMention(extractCreateContent(content, content));
    const [item] = await db
      .insert(itemsTable)
      .values({
        userId,
        type: "note",
        title: titleFromText(text, "Новая заметка"),
        content: text,
        folderId: folder?.id ?? null,
        status: "active",
        aiTags: [],
      })
      .returning();
    const savedItem = savedItemFromRecord(item, folders);
    const message = `Готово: сохранил заметку «${item.title}»${folder ? ` в папку «${folder.name}»` : ""}.`;
    return {
      ...baseResponse("create_note", message),
      type: "note",
      shouldSave: true,
      savedItem: itemResponse(item, folders),
      assistantContext: {
        intentType: "create_note",
        responseMode: "saved",
        autoSaved: true,
        assistantReply: message,
        savedItem,
        actionResult: { success: true, action: "create_note" },
      },
    };
  }

  if (CREATE_REMINDER_RE.test(normalized) || (/(завтра|послезавтра|сегодня|\d{1,2}[:.]\d{2})/i.test(normalized) && !/(помоги|объясни|какие|найди|покажи)/i.test(normalized))) {
    const remindAt = parseRussianDateTime(content);
    const folder = findFolder(folders, extractFolderName(content)) ?? (folderId ? folders.find((entry) => entry.id === folderId) ?? null : null);
    const text = stripFolderMention(removeDateWords(extractCreateContent(content, content)).replace(/^(напомни|не\s+забыть)\s*/i, ""));
    if (!remindAt && CREATE_REMINDER_RE.test(normalized)) {
      return baseResponse("unknown_or_ambiguous", "Когда поставить напоминание? Укажите дату и время, например: завтра в 10:00.");
    }
    const [item] = await db
      .insert(itemsTable)
      .values({
        userId,
        type: "reminder",
        title: titleFromText(text, "Новое напоминание"),
        content: text,
        folderId: folder?.id ?? null,
        reminderAt: remindAt,
        status: "active",
        aiTags: [],
      })
      .returning();
    const savedItem = savedItemFromRecord(item, folders);
    const datePart = remindAt ? ` на ${formatMoscowDateTime(remindAt)}` : "";
    const message = `Готово: создал напоминание «${item.title}»${datePart}.`;
    return {
      ...baseResponse("create_reminder", message),
      type: "reminder",
      shouldSave: true,
      reminderAt: remindAt?.toISOString() ?? null,
      savedItem: itemResponse(item, folders),
      assistantContext: {
        intentType: "create_reminder",
        responseMode: "saved",
        autoSaved: true,
        assistantReply: message,
        savedItem,
        actionResult: { success: true, action: "create_reminder" },
      },
    };
  }

  if (UPDATE_RE.test(normalized) && REMINDER_WORD_RE.test(normalized)) {
    const target = extractTarget(content, "reminder") || removeDateWords(content).replace(/измени|обнови|перенеси|напоминание|про/gi, "");
    const remindAt = parseRussianDateTime(content);
    if (!remindAt) return baseResponse("update_reminder", "На какую дату и время перенести напоминание?");
    const matches = searchItems(items, target, "reminder");
    if (matches.length === 0) return baseResponse("update_reminder", `Я не нашел напоминание${target ? ` про «${compact(target)}»` : ""}. Могу создать новое.`);
    if (matches.length > 1) return baseResponse("update_reminder", listItemsMessage("Я нашел несколько напоминаний, уточните какое изменить", matches, folders));
    const [updated] = await db
      .update(itemsTable)
      .set({ reminderAt: remindAt })
      .where(and(eq(itemsTable.id, matches[0].id), eq(itemsTable.userId, userId), eq(itemsTable.type, "reminder")))
      .returning();
    if (!updated) return baseResponse("update_reminder", "Не удалось изменить напоминание: объект не найден.");
    return baseResponse("update_reminder", `Готово: перенес напоминание «${updated.title}» на ${formatMoscowDateTime(remindAt)}.`);
  }

  if (DELETE_RE.test(normalized) && (NOTE_WORD_RE.test(normalized) || FILE_WORD_RE.test(normalized) || REMINDER_WORD_RE.test(normalized))) {
    const type = NOTE_WORD_RE.test(normalized) ? "note" : FILE_WORD_RE.test(normalized) ? "file" : "reminder";
    const target = extractTarget(content, type);
    const matches = searchItems(items, target, type);
    if (matches.length === 0) return baseResponse(`delete_${type}` as AssistantActionIntent, `Я не нашел ${type === "note" ? "заметку" : type === "file" ? "файл" : "напоминание"}${target ? ` «${target}»` : ""}.`);
    if (matches.length > 1) return baseResponse(`delete_${type}` as AssistantActionIntent, listItemsMessage("Нашел несколько объектов, уточните какой удалить", matches, folders));
    const item = matches[0];
    return withPending(
      `delete_${type}` as AssistantActionIntent,
      `Удалить ${type === "note" ? "заметку" : type === "file" ? "файл" : "напоминание"} «${itemTitle(item)}»? Ответьте «да», чтобы подтвердить.`,
      { action: "delete_item", itemId: item.id, itemType: type, title: itemTitle(item) },
    );
  }

  if (/перемест|перенеси|добавь.+в\s+папк/i.test(normalized)) {
    const folder = findFolder(folders, extractFolderName(content));
    if (!folder) return baseResponse("move_item_to_folder", "Я не нашел целевую папку. Уточните название папки или создайте её.");
    const type = NOTE_WORD_RE.test(normalized) ? "note" : FILE_WORD_RE.test(normalized) ? "file" : REMINDER_WORD_RE.test(normalized) ? "reminder" : undefined;
    const target = type ? extractTarget(content, type) : extractTarget(content, "item");
    const matches = searchItems(items, target, type);
    if (matches.length === 0) return baseResponse("move_item_to_folder", `Я не нашел объект${target ? ` «${target}»` : ""}.`);
    if (matches.length > 1) return baseResponse("move_item_to_folder", listItemsMessage("Нашел несколько объектов, уточните какой переместить", matches, folders));
    const [updated] = await db.update(itemsTable).set({ folderId: folder.id }).where(and(eq(itemsTable.id, matches[0].id), eq(itemsTable.userId, userId))).returning();
    if (!updated) return baseResponse("move_item_to_folder", "Не удалось переместить объект: он не найден.");
    return baseResponse("move_item_to_folder", `Готово: переместил «${itemTitle(updated)}» в папку «${folder.name}».`);
  }

  if (UPDATE_RE.test(normalized) && NOTE_WORD_RE.test(normalized)) {
    return baseResponse("update_note", "Чтобы изменить заметку, укажите её название и новый текст. Например: «измени заметку про адаптив: новый текст...».");
  }

  if (/перескажи|что\s+в\s+файле|по\s+этому\s+файлу|этот\s+файл|этот\s+документ/i.test(normalized)) {
    return chatResponse();
  }

  logger.info({ ...logBase, intent: "chat_general" }, "[assistant] no deterministic action, fallback to AI chat");
  return chatResponse();
}

export function shouldSuppressSaveCta(content: string): boolean {
  const normalized = normalizeText(content);
  return (
    /^(помоги|объясни|расскажи|составь|напиши|проверь|найди|покажи|какие|что\s+у\s+меня)/i.test(normalized) ||
    SEARCH_RE.test(normalized)
  );
}
