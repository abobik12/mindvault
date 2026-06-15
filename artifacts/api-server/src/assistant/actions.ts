import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { conversations, db, foldersTable, itemsTable, messages } from "@workspace/db";
import { formatMoscowDateTime, parseReminderDateTime } from "../lib/time";
import { logger } from "../lib/logger";
import {
  compact,
  getKeywordCommand,
  isLikelyQuestion,
  looksLikeListCandidate,
  looksLikeReminderCandidate,
  normalizeText,
  parseListCommand,
  parseReminderCommand,
  serializeListContent,
  titleFromText,
  type KeywordCommand,
} from "./command-parser";
import type { AssistantIntent } from "./assistant-intent";
import type {
  AssistantActionButton,
  PendingAssistantAction,
} from "./assistant-contract";

export type AssistantActionIntent =
  | "chat_general"
  | "search_user_content"
  | "answer_about_user_content"
  | "create_note"
  | "create_list"
  | "update_list"
  | "update_note"
  | "delete_note"
  | "delete_list"
  | "create_reminder"
  | "update_reminder"
  | "delete_reminder"
  | "search_reminders"
  | "search_files"
  | "answer_about_file"
  | "answer_from_sources"
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
    type: "note" | "file" | "reminder" | "list";
    title: string;
    folderId: number | null;
    folderName: string | null;
    reminderAt?: string | null;
    content?: string | null;
  } | null;
  suggestedActions?: Array<"save_note" | "save_reminder" | "create_list" | "ignore">;
  pendingAction?: LegacyPendingAction | PendingAssistantAction;
  actionButtons?: AssistantActionButton[];
  actionResult?: {
    success: boolean;
    action: string;
    error?: string;
  };
  undoAction?: {
    id: string;
    label: string;
  };
};

export type AssistantActionResponse = {
  handled: boolean;
  type: "note" | "reminder" | "file" | "list" | "folder" | "chat";
  intentType: AssistantActionIntent;
  responseMode: AssistantActionContext["responseMode"];
  shouldSave: boolean;
  title: string | null;
  summary: string | null;
  cleanedContent: string | null;
  suggestedFolder: string | null;
  tags: string[];
  reminderAt: string | null;
  savedItem: Record<string, unknown> | null;
  suggestedActions: Array<"save_note" | "save_reminder" | "create_list" | "ignore">;
  assistantContext: AssistantActionContext;
  message: string;
};

type LegacyPendingAction =
  | {
      action: "delete_item";
      itemId: number;
      itemType: "note" | "file" | "reminder" | "list";
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
    }
  | {
      action: "create_reminder";
      text: string;
      reminderAt?: string | null;
    };

type ItemRecord = typeof itemsTable.$inferSelect;
type ItemInsert = typeof itemsTable.$inferInsert;
type FolderRecord = typeof foldersTable.$inferSelect;
type ActionPersistence = {
  insertItem(values: ItemInsert): Promise<ItemRecord>;
};

const databasePersistence: ActionPersistence = {
  async insertItem(values) {
    const [item] = await db.insert(itemsTable).values(values).returning();
    if (!item) throw new Error("Item insert did not return a record");
    return item;
  },
};

const NOTE_WORD_RE = /(заметк|запис|иде[яюи])/i;
const FILE_WORD_RE = /(файл|документ|вложен|презентац|pdf|docx|pptx|txt|md|csv)/i;
const REMINDER_WORD_RE = /(напомин|дедлайн|срок|задач|не\s+забыть)/i;
const LIST_WORD_RE = /(список|чеклист|todo|to-do|покупк)/i;
const FOLDER_WORD_RE = /(папк|раздел|каталог)/i;
const SEARCH_RE = /(какие|покажи|найди|что\s+у\s+меня|что\s+я\s+сохранял|список|перечисли)/i;
const CREATE_NOTE_RE = /(сохрани|создай|добавь|запиши).{0,40}(заметк|запис|иде)|^идея\s*[:：-]/i;
const CREATE_REMINDER_RE = /(напомни|создай\s+напомин|поставь\s+напомин|добавь\s+напомин|не\s+забыть)/i;
const UPDATE_RE = /(измени|обнови|перенеси|переименуй|исправь)/i;
const DELETE_RE = /(удали|удалить|сотри)/i;
const CONFIRM_RE = /^(да|подтверждаю|удали|удаляй|очисти|очищай|точно|ок|хорошо)$/i;
const CANCEL_RE = /^(нет|отмена|отмени|не надо|не удаляй|оставь|стоп|cancel)$/i;
const EXPLICIT_REMINDER_REQUEST_RE =
  /(напомни|напоминание|не\s+забыть|не\s+забудь|создай.{0,20}напомин|поставь.{0,20}напомин|добавь.{0,20}напомин)/i;
const LEGACY_AUTO_SAVE_ENABLED = false;

type AssistantItemType = "note" | "file" | "reminder" | "list";
type SuggestedActionType = "save_note" | "save_reminder" | "create_list" | "ignore";
export type ActionTarget = {
  id: number;
  type: AssistantItemType;
  title: string;
  score: number;
};

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

function failureResponse(
  intentType: AssistantActionIntent,
  message: string,
  error = "not_executed",
): AssistantActionResponse {
  return {
    ...baseResponse(intentType, message),
    assistantContext: {
      intentType,
      responseMode: "action_executed",
      assistantReply: message,
      savedItem: null,
      actionResult: { success: false, action: intentType, error },
    },
  };
}

function chatResponse(
  intentType: "chat_general" | "answer_from_sources" = "chat_general",
): AssistantActionResponse {
  return {
    ...baseResponse(intentType, "Понял запрос. Отвечаю в чате без автоматического сохранения."),
    handled: false,
    responseMode: "reply_only",
    assistantContext: {
      intentType,
      responseMode: "reply_only",
      assistantReply: "Понял запрос. Отвечаю в чате без автоматического сохранения.",
      savedItem: null,
    },
  };
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
    content: item.content ?? null,
  };
}

async function createReminderItem({
  userId,
  text,
  reminderAt,
  folder,
  folders,
  persistence = databasePersistence,
}: {
  userId: number;
  text: string;
  reminderAt: Date;
  folder: FolderRecord | null;
  folders: FolderRecord[];
  persistence?: ActionPersistence;
}): Promise<AssistantActionResponse> {
  const reminderText = compact(text);
  if (!reminderText) return failureResponse("unknown_or_ambiguous", "Уточните текст напоминания.", "clarification_required");

  const item = await persistence.insertItem({
    userId,
    type: "reminder",
    title: titleFromText(reminderText, "Новое напоминание"),
    content: reminderText,
    folderId: folder?.id ?? null,
    reminderAt,
    status: "active",
    aiTags: [],
  });

  const savedItem = savedItemFromRecord(item, folders);
  const message = `Создал напоминание «${item.title}» на ${formatMoscowDateTime(reminderAt)}.`;
  return {
    ...baseResponse("create_reminder", message),
    type: "reminder",
    responseMode: "saved",
    shouldSave: true,
    title: item.title,
    cleanedContent: reminderText,
    reminderAt: reminderAt.toISOString(),
    savedItem: itemResponse(item, folders),
    assistantContext: {
      intentType: "create_reminder",
      responseMode: "saved",
      autoSaved: false,
      assistantReply: message,
      savedItem,
      actionResult: { success: true, action: "create_reminder" },
    },
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

function extractTarget(message: string, type: "note" | "file" | "reminder" | "list" | "folder" | "item"): string {
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
          : type === "list"
            ? "(?:список|чеклист)"
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

function findSystemFolder(folders: FolderRecord[], names: string[]): FolderRecord | null {
  const normalizedNames = names.map(normalizeText);
  return (
    folders.find(
      (folder) =>
        folder.isSystem &&
        normalizedNames.includes(normalizeText(folder.name)),
    ) ?? null
  );
}

function searchItems(items: ItemRecord[], query: string, type?: AssistantItemType): ItemRecord[] {
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

export function findActionTargets({
  items,
  folders,
  query,
  type,
  folderName,
  dateHint,
}: {
  items: ItemRecord[];
  folders: FolderRecord[];
  query: string;
  type?: AssistantItemType;
  folderName?: string | null;
  dateHint?: string | null;
}): ActionTarget[] {
  const normalizedQuery = normalizeText(query);
  const terms = normalizedQuery
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => term.length > 2);
  const normalizedFolder = folderName ? normalizeText(folderName) : null;
  const normalizedDate = dateHint ? normalizeText(dateHint) : null;

  const scored = items
    .filter((item) => item.status === "active" && (!type || item.type === type))
    .map((item) => {
      const title = normalizeText(itemTitle(item));
      const content = normalizeText(
        [item.content ?? "", item.summary ?? "", item.originalFilename ?? ""].join(" "),
      );
      const itemFolder = normalizeText(folderNameFor(item, folders) ?? "");
      const reminderDate =
        item.reminderAt?.toLocaleDateString("ru-RU", {
          timeZone: "Europe/Moscow",
          day: "numeric",
          month: "long",
          year: "numeric",
        }) ?? "";

      let score = 0;
      if (title === normalizedQuery) score += 200;
      else if (title.includes(normalizedQuery) || normalizedQuery.includes(title)) score += 120;
      if (content.includes(normalizedQuery)) score += 80;
      score += terms.reduce((sum, term) => {
        if (title.includes(term)) return sum + 30;
        if (content.includes(term)) return sum + 12;
        return sum;
      }, 0);
      if (normalizedFolder && itemFolder.includes(normalizedFolder)) score += 50;
      if (normalizedDate && normalizeText(reminderDate).includes(normalizedDate)) score += 40;

      return {
        id: item.id,
        type: item.type,
        title: itemTitle(item),
        score,
      };
    })
    .filter((target) => target.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length <= 1) return scored;
  const topScore = scored[0]?.score ?? 0;
  return scored.filter((target) => target.score >= Math.max(20, topScore * 0.55)).slice(0, 6);
}

function parseStoredListItems(content: string | null): Array<{
  id: string;
  text: string;
  done: boolean;
}> {
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as {
      kind?: string;
      items?: Array<{ id?: string; text?: string; done?: boolean }>;
    };
    if (parsed.kind !== "todo-list" || !Array.isArray(parsed.items)) return [];
    return parsed.items
      .filter((entry) => typeof entry.text === "string" && entry.text.trim())
      .map((entry, index) => ({
        id: entry.id || `item-${Date.now()}-${index}`,
        text: entry.text!.trim(),
        done: entry.done === true,
      }));
  } catch {
    return [];
  }
}

function serializeStoredListItems(
  items: Array<{ id: string; text: string; done: boolean }>,
): string {
  return JSON.stringify({ kind: "todo-list", items });
}

export function applyListItemUpdates(
  listItems: Array<{ id: string; text: string; done: boolean }>,
  updates: {
    addItems?: string[];
    removeItems?: string[];
    completeItems?: string[];
    reopenItems?: string[];
  },
) {
  const removeTerms = (updates.removeItems ?? []).map(normalizeText);
  const completeTerms = (updates.completeItems ?? []).map(normalizeText);
  const reopenTerms = (updates.reopenItems ?? []).map(normalizeText);
  const nextItems = listItems
    .filter(
      (entry) =>
        !removeTerms.some((term) =>
          normalizeText(entry.text).includes(term),
        ),
    )
    .map((entry) => {
      const normalized = normalizeText(entry.text);
      if (completeTerms.some((term) => normalized.includes(term))) {
        return { ...entry, done: true };
      }
      if (reopenTerms.some((term) => normalized.includes(term))) {
        return { ...entry, done: false };
      }
      return entry;
    });

  for (const text of updates.addItems ?? []) {
    if (
      !nextItems.some(
        (entry) => normalizeText(entry.text) === normalizeText(text),
      )
    ) {
      nextItems.push({
        id: `item-${Date.now()}-${nextItems.length}`,
        text,
        done: false,
      });
    }
  }

  return nextItems;
}

function extractSearchQuery(message: string): string {
  return compact(
    message
      .replace(/^(?:найди|покажи|перечисли|какие|что\s+у\s+меня\s+сохранено|что\s+я\s+сохранял)\s*/i, "")
      .replace(/\b(?:заметки?|записи?|файлы?|документы?|напоминания?|списки?|чеклисты?|материалы?)\b/gi, " ")
      .replace(/^(?:по|про|о)\s+/i, ""),
  );
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

async function getLatestPendingAction(conversationId: number | null | undefined): Promise<LegacyPendingAction | null> {
  if (!conversationId) return null;
  const rows = await db
    .select({ metadata: messages.metadata, role: messages.role })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(6);

  let newerUserMessages = 0;
  for (const row of rows) {
    if (row.role === "user") {
      newerUserMessages += 1;
      if (newerUserMessages > 1) return null;
      continue;
    }
    if (row.role !== "assistant") return null;
    if (!row.metadata || typeof row.metadata !== "object") return null;
    const pendingAction = (row.metadata as Record<string, unknown>).pendingAction;
    if (pendingAction && typeof pendingAction === "object" && "action" in pendingAction) {
      return pendingAction as LegacyPendingAction;
    }
    return null;
  }
  return null;
}

async function executePendingAction(userId: number, action: LegacyPendingAction, folders: FolderRecord[]): Promise<AssistantActionResponse> {
  if (action.action === "create_reminder") {
    if (!action.reminderAt) {
      return withPending(
        "create_reminder",
        `Укажите дату для напоминания «${action.text}».`,
        action,
      );
    }

    const reminderAt = new Date(action.reminderAt);
    if (Number.isNaN(reminderAt.getTime())) {
      return failureResponse("create_reminder", "Не удалось создать напоминание: дата распознана некорректно.", "invalid_date");
    }

    return createReminderItem({
      userId,
      text: action.text,
      reminderAt,
      folder: null,
      folders,
    });
  }

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

    const deletedTypeLabel =
      action.itemType === "note" ? "заметку" : action.itemType === "file" ? "файл" : action.itemType === "list" ? "список" : "напоминание";
    const message = `Готово: удалил ${deletedTypeLabel} «${itemTitle(deleted)}».`;
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

async function continuePendingReminderAction({
  userId,
  action,
  content,
  folders,
  folderId,
}: {
  userId: number;
  action: Extract<LegacyPendingAction, { action: "create_reminder" }>;
  content: string;
  folders: FolderRecord[];
  folderId?: number | null;
}): Promise<AssistantActionResponse> {
  const normalized = normalizeText(content);
  const folder = folderId ? folders.find((entry) => entry.id === folderId) ?? null : null;

  if (CANCEL_RE.test(normalized)) {
    return failureResponse("unknown_or_ambiguous", "Ок, создание напоминания отменено.", "cancelled");
  }

  if (CONFIRM_RE.test(normalized)) {
    if (!action.reminderAt) {
      return withPending(
        "create_reminder",
        `Укажите дату для напоминания «${action.text}».`,
        action,
      );
    }

    const reminderAt = new Date(action.reminderAt);
    if (Number.isNaN(reminderAt.getTime())) {
      return failureResponse("create_reminder", "Не удалось создать напоминание: дата распознана некорректно.", "invalid_date");
    }

    return createReminderItem({ userId, text: action.text, reminderAt, folder, folders });
  }

  const parsed = parseReminderCommand(content);
  if (parsed.hasDate && parsed.reminderAt) {
    const reminderText = parsed.text || action.text;
    return createReminderItem({ userId, text: reminderText, reminderAt: parsed.reminderAt, folder, folders });
  }

  if (parsed.hasTime && action.reminderAt) {
    const baseDate = new Date(action.reminderAt);
    const timeOnly = parseReminderCommand(`сегодня ${content}`);
    if (!Number.isNaN(baseDate.getTime()) && timeOnly.reminderAt) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Moscow",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(timeOnly.reminderAt);
      const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
      const hour = Number(pick("hour"));
      const minute = Number(pick("minute"));
      const dateParts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Moscow",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(baseDate);
      const datePick = (type: Intl.DateTimeFormatPartTypes) => dateParts.find((part) => part.type === type)?.value ?? "";
      const reminderAt = new Date(Date.UTC(Number(datePick("year")), Number(datePick("month")) - 1, Number(datePick("day")), hour - 3, minute));
      return createReminderItem({ userId, text: action.text, reminderAt, folder, folders });
    }
  }

  return withPending(
    "create_reminder",
    `Укажите дату для напоминания «${action.text}». Например: 29 июня или завтра в 10:00.`,
    action,
  );
}

function withPending(intent: AssistantActionIntent, message: string, pendingAction: LegacyPendingAction): AssistantActionResponse {
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

function createPendingAssistantAction({
  kind,
  originalMessage,
  intent,
  possibleIntents,
  targetCandidates,
  payload,
}: Omit<PendingAssistantAction, "id" | "status" | "createdAt" | "expiresAt">): PendingAssistantAction {
  const createdAt = new Date();
  return {
    id: randomUUID(),
    kind,
    originalMessage,
    intent,
    possibleIntents,
    targetCandidates,
    payload,
    status: "pending",
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 30 * 60 * 1000).toISOString(),
  };
}

export function createStructuredPendingResponse({
  intentType = "unknown_or_ambiguous",
  message,
  pendingAction,
  buttons,
  error = "selection_required",
}: {
  intentType?: AssistantActionIntent;
  message: string;
  pendingAction: PendingAssistantAction;
  buttons: AssistantActionButton[];
  error?: string;
}): AssistantActionResponse {
  return {
    ...baseResponse(intentType, message),
    responseMode: "suggest_actions",
    assistantContext: {
      intentType,
      responseMode: "suggest_actions",
      assistantReply: message,
      savedItem: null,
      pendingAction,
      actionButtons: buttons,
      actionResult: {
        success: false,
        action: pendingAction.intent ?? pendingAction.kind,
        error,
      },
    },
  };
}

export function createClarificationResponse(
  message = "Уточните, пожалуйста, что нужно сделать.",
): AssistantActionResponse {
  return failureResponse(
    "unknown_or_ambiguous",
    message,
    "clarification_required",
  );
}

export function createCancelledResponse(): AssistantActionResponse {
  return failureResponse(
    "unknown_or_ambiguous",
    "Действие отменено.",
    "cancelled",
  );
}

function withSuggestedActions(
  message: string,
  suggestedActions: SuggestedActionType[],
  originalMessage?: string,
): AssistantActionResponse {
  if (originalMessage) {
    const intentMap: Record<SuggestedActionType, "create_note" | "create_list" | "create_reminder" | "cancel"> = {
      save_note: "create_note",
      save_reminder: "create_reminder",
      create_list: "create_list",
      ignore: "cancel",
    };
    const labelMap: Record<SuggestedActionType, string> = {
      save_note: "Сохранить как заметку",
      save_reminder: "Создать напоминание",
      create_list: "Создать список",
      ignore: "Не сохранять",
    };
    const possibleIntents = suggestedActions.map((action) => intentMap[action]);
    const pendingAction = createPendingAssistantAction({
      kind: "choose_intent",
      originalMessage,
      possibleIntents,
      payload: {},
    });
    return createStructuredPendingResponse({
      message,
      pendingAction,
      buttons: suggestedActions.map((action) => ({
        label: labelMap[action],
        pendingActionId: pendingAction.id,
        selectedIntent: intentMap[action],
        cancel: action === "ignore",
      })),
    });
  }

  return {
    ...baseResponse("unknown_or_ambiguous", message),
    responseMode: "suggest_actions",
    suggestedActions,
    assistantContext: {
      intentType: "unknown_or_ambiguous",
      responseMode: "suggest_actions",
      assistantReply: message,
      savedItem: null,
      suggestedActions,
      actionResult: { success: false, action: "suggest_action", error: "confirmation_required" },
    },
  };
}

export async function executeKeywordCommand({
  command,
  userId,
  folders,
  folderId,
  persistence = databasePersistence,
}: {
  command: KeywordCommand;
  userId: number;
  folders: FolderRecord[];
  folderId?: number | null;
  persistence?: ActionPersistence;
}): Promise<AssistantActionResponse> {
  const explicitFolder = folderId ? folders.find((entry) => entry.id === folderId) ?? null : null;

  if (command.kind === "note") {
    const folder = explicitFolder ?? findSystemFolder(folders, ["Заметки", "Notes"]);
    const text = compact(command.text);
    if (!text) return failureResponse("unknown_or_ambiguous", "Введите текст заметки после слова «заметка».", "clarification_required");

    const item = await persistence.insertItem({
      userId,
      type: "note",
      title: titleFromText(text, "Новая заметка"),
      content: text,
      folderId: folder?.id ?? null,
      status: "active",
      aiTags: [],
    });

    const savedItem = savedItemFromRecord(item, folders);
    const message = `Заметка сохранена: ${text}`;
    return {
      ...baseResponse("create_note", message),
      type: "note",
      responseMode: "saved",
      shouldSave: true,
      title: item.title,
      cleanedContent: text,
      savedItem: itemResponse(item, folders),
      assistantContext: {
        intentType: "create_note",
        responseMode: "saved",
        autoSaved: false,
        assistantReply: message,
        savedItem,
        actionResult: { success: true, action: "create_note" },
      },
    };
  }

  if (command.kind === "reminder") {
    const folder = explicitFolder ?? findSystemFolder(folders, ["Напоминания", "Reminders"]);
    const text = compact(command.text);
    if (!text) return failureResponse("unknown_or_ambiguous", "Введите текст напоминания после слова «напоминание».", "clarification_required");

    const parsed = parseReminderCommand(text);
    if (!parsed.hasDate || !parsed.reminderAt) {
      const pendingText = parsed.text || text;
      return withPending(
        "create_reminder",
        `Укажите дату для напоминания «${pendingText}».`,
        { action: "create_reminder", text: pendingText, reminderAt: null },
      );
    }
    if (!parsed.text) return failureResponse("unknown_or_ambiguous", "Уточните текст напоминания.", "clarification_required");

    const reminderText = parsed.text;
    return createReminderItem({
      userId,
      text: reminderText,
      reminderAt: parsed.reminderAt,
      folder,
      folders,
      persistence,
    });
  }

  const parsed = parseListCommand(command.text);
  if (!parsed) return failureResponse("unknown_or_ambiguous", "Введите пункты списка после слова «список».", "clarification_required");

  const folder = explicitFolder ?? findSystemFolder(folders, ["Входящие", "Inbox"]);
  const content = serializeListContent(parsed.items);
  const item = await persistence.insertItem({
    userId,
    type: "list",
    title: parsed.title,
    content,
    folderId: folder?.id ?? null,
    status: "active",
    aiTags: [],
  });

  const savedItem = savedItemFromRecord(item, folders);
  const message = [`Список создан: ${parsed.title}`, ...parsed.items.map((entry) => `- ${entry}`)].join("\n");
  return {
    ...baseResponse("create_list", message),
    type: "list",
    responseMode: "saved",
    shouldSave: true,
    title: item.title,
    cleanedContent: content,
    savedItem: itemResponse(item, folders),
    assistantContext: {
      intentType: "create_list",
      responseMode: "saved",
      autoSaved: false,
      assistantReply: message,
      savedItem,
      actionResult: { success: true, action: "create_list" },
    },
  };
}

export async function executeValidatedAssistantIntent({
  intent,
  userId,
  originalMessage,
  folderId,
  selectedItemId,
  confirmed = false,
  folders: providedFolders,
  items: providedItems,
  persistence = databasePersistence,
}: {
  intent: AssistantIntent;
  userId: number;
  originalMessage?: string;
  folderId?: number | null;
  selectedItemId?: number | null;
  confirmed?: boolean;
  folders?: FolderRecord[];
  items?: ItemRecord[];
  persistence?: ActionPersistence;
}): Promise<AssistantActionResponse> {
  if (intent.intent === "clarify") {
    return createClarificationResponse(intent.data.question);
  }

  if (intent.intent === "chat_general") return chatResponse();
  if (intent.intent === "answer_from_sources") {
    return chatResponse("answer_from_sources");
  }
  if (intent.intent === "cancel") {
    return failureResponse(
      "unknown_or_ambiguous",
      "Действие отменено.",
      "cancelled",
    );
  }

  const folders =
    providedFolders ??
    (await db.select().from(foldersTable).where(eq(foldersTable.userId, userId)));
  const explicitFolder = folderId
    ? folders.find((entry) => entry.id === folderId) ?? null
    : null;
  const resolveFolder = (
    requestedName: string | null | undefined,
    systemNames: string[],
  ): FolderRecord | null | undefined => {
    if (requestedName) return findFolder(folders, requestedName) ?? undefined;
    return explicitFolder ?? findSystemFolder(folders, systemNames);
  };
  const loadItems = async (): Promise<ItemRecord[]> =>
    providedItems ??
    (await db
      .select()
      .from(itemsTable)
      .where(and(eq(itemsTable.userId, userId), eq(itemsTable.status, "active")))
      .orderBy(desc(itemsTable.updatedAt))
      .limit(1000));
  const resolveMutationTarget = async (
    query: string,
    type?: AssistantItemType,
    dateHint?: string | null,
  ) => {
    const items = await loadItems();
    if (selectedItemId) {
      const selected = items.find(
        (item) => item.id === selectedItemId && (!type || item.type === type),
      );
      return { items, target: selected ?? null, candidates: [] as ActionTarget[] };
    }
    const candidates = findActionTargets({
      items,
      folders,
      query,
      type,
      dateHint,
    });
    const hasClearLeader =
      candidates.length === 1 ||
      (candidates.length > 1 && candidates[0].score > candidates[1].score);
    const target = hasClearLeader
      ? items.find((item) => item.id === candidates[0].id) ?? null
      : null;
    return { items, target, candidates: target ? [] : candidates };
  };
  const targetSelectionResponse = (
    intentType: AssistantActionIntent,
    candidates: ActionTarget[],
  ) => {
    return failureResponse(
      intentType,
      `Нашёл несколько одинаково подходящих объектов: ${candidates
        .slice(0, 4)
        .map((candidate) => `«${candidate.title}»`)
        .join(", ")}. Какой именно вы имеете в виду?`,
      "ambiguous",
    );
  };

  if (intent.intent === "create_note") {
    const folder = resolveFolder(intent.data.folderName, ["Заметки", "Notes"]);
    if (intent.data.folderName && folder === undefined) {
      return failureResponse(
        "create_note",
        `Я не нашёл папку «${intent.data.folderName}». Уточните папку или создайте её.`,
        "folder_not_found",
      );
    }

    const item = await persistence.insertItem({
      userId,
      type: "note",
      title: intent.data.title,
      content: intent.data.content,
      folderId: folder?.id ?? null,
      status: "active",
      aiTags: [],
    });
    const savedItem = savedItemFromRecord(item, folders);
    const message = `Заметка сохранена: ${item.title}`;
    return {
      ...baseResponse("create_note", message),
      type: "note",
      responseMode: "saved",
      shouldSave: true,
      title: item.title,
      cleanedContent: item.content,
      savedItem: itemResponse(item, folders),
      assistantContext: {
        intentType: "create_note",
        responseMode: "saved",
        autoSaved: false,
        assistantReply: message,
        savedItem,
        actionResult: { success: true, action: "create_note" },
      },
    };
  }

  if (intent.intent === "create_list") {
    const folder = resolveFolder(intent.data.folderName, ["Входящие", "Inbox"]);
    if (intent.data.folderName && folder === undefined) {
      return failureResponse(
        "create_list",
        `Я не нашёл папку «${intent.data.folderName}». Уточните папку или создайте её.`,
        "folder_not_found",
      );
    }

    const content = serializeListContent(intent.data.items);
    const item = await persistence.insertItem({
      userId,
      type: "list",
      title: intent.data.title,
      content,
      folderId: folder?.id ?? null,
      status: "active",
      aiTags: [],
    });
    const savedItem = savedItemFromRecord(item, folders);
    const message = [
      `Список создан: ${item.title}`,
      ...intent.data.items.map((entry) => `- ${entry}`),
    ].join("\n");
    return {
      ...baseResponse("create_list", message),
      type: "list",
      responseMode: "saved",
      shouldSave: true,
      title: item.title,
      cleanedContent: content,
      savedItem: itemResponse(item, folders),
      assistantContext: {
        intentType: "create_list",
        responseMode: "saved",
        autoSaved: false,
        assistantReply: message,
        savedItem,
        actionResult: { success: true, action: "create_list" },
      },
    };
  }

  if (intent.intent === "create_reminder") {
    const folder = resolveFolder(intent.data.folderName, [
      "Напоминания",
      "Reminders",
    ]);
    if (intent.data.folderName && folder === undefined) {
      return failureResponse(
        "create_reminder",
        `Я не нашёл папку «${intent.data.folderName}». Уточните папку или создайте её.`,
        "folder_not_found",
      );
    }

    const reminderAt = parseReminderDateTime(
      `${intent.data.date}T${intent.data.time}`,
    );
    if (!reminderAt || reminderAt.getTime() <= Date.now()) {
      return failureResponse(
        "create_reminder",
        "Дата напоминания должна быть корректной и находиться в будущем.",
        "invalid_date",
      );
    }

    const text = intent.data.content || intent.data.title;
    const item = await persistence.insertItem({
      userId,
      type: "reminder",
      title: intent.data.title,
      content: text,
      folderId: folder?.id ?? null,
      reminderAt,
      status: "active",
      aiTags: [],
    });
    const savedItem = savedItemFromRecord(item, folders);
    const message = `Создал напоминание «${item.title}» на ${formatMoscowDateTime(reminderAt)}.`;
    return {
      ...baseResponse("create_reminder", message),
      type: "reminder",
      responseMode: "saved",
      shouldSave: true,
      title: item.title,
      cleanedContent: text,
      reminderAt: reminderAt.toISOString(),
      savedItem: itemResponse(item, folders),
      assistantContext: {
        intentType: "create_reminder",
        responseMode: "saved",
        autoSaved: false,
        assistantReply: message,
        savedItem,
        actionResult: { success: true, action: "create_reminder" },
      },
    };
  }

  if (intent.intent === "update_note") {
    const { target, candidates } = await resolveMutationTarget(
      intent.data.targetQuery,
      "note",
    );
    if (candidates.length > 1) {
      return targetSelectionResponse("update_note", candidates);
    }
    if (!target) {
      return failureResponse(
        "update_note",
        `Я не нашёл заметку по запросу «${intent.data.targetQuery}».`,
        "not_found",
      );
    }
    const [updated] = await db
      .update(itemsTable)
      .set({
        ...(intent.data.title ? { title: intent.data.title } : {}),
        ...(intent.data.content ? { content: intent.data.content } : {}),
      })
      .where(
        and(
          eq(itemsTable.id, target.id),
          eq(itemsTable.userId, userId),
          eq(itemsTable.type, "note"),
        ),
      )
      .returning();
    if (!updated) {
      return failureResponse("update_note", "Не удалось изменить заметку.", "not_found");
    }
    return baseResponse("update_note", `Заметка изменена: «${updated.title}».`);
  }

  if (intent.intent === "update_list") {
    const { target, candidates } = await resolveMutationTarget(
      intent.data.targetQuery,
      "list",
    );
    if (candidates.length > 1) {
      return targetSelectionResponse("update_list", candidates);
    }
    if (!target) {
      return failureResponse(
        "update_list",
        `Я не нашёл список по запросу «${intent.data.targetQuery}».`,
        "not_found",
      );
    }

    const listItems = applyListItemUpdates(
      parseStoredListItems(target.content),
      intent.data,
    );

    const [updated] = await db
      .update(itemsTable)
      .set({
        ...(intent.data.title ? { title: intent.data.title } : {}),
        content: serializeStoredListItems(listItems),
      })
      .where(
        and(
          eq(itemsTable.id, target.id),
          eq(itemsTable.userId, userId),
          eq(itemsTable.type, "list"),
        ),
      )
      .returning();
    if (!updated) {
      return failureResponse("update_list", "Не удалось изменить список.", "not_found");
    }
    return baseResponse("update_list", `Список изменён: «${updated.title}».`);
  }

  if (intent.intent === "update_reminder") {
    const { target, candidates } = await resolveMutationTarget(
      intent.data.targetQuery,
      "reminder",
      intent.data.date,
    );
    if (candidates.length > 1) {
      return targetSelectionResponse("update_reminder", candidates);
    }
    if (!target) {
      return failureResponse(
        "update_reminder",
        `Я не нашёл напоминание по запросу «${intent.data.targetQuery}».`,
        "not_found",
      );
    }

    let reminderAt = target.reminderAt;
    if (intent.data.date || intent.data.time) {
      const existingParts = target.reminderAt
        ? new Intl.DateTimeFormat("en-CA", {
            timeZone: "Europe/Moscow",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).formatToParts(target.reminderAt)
        : [];
      const pick = (type: Intl.DateTimeFormatPartTypes) =>
        existingParts.find((part) => part.type === type)?.value ?? "";
      const date =
        intent.data.date ||
        `${pick("year")}-${pick("month")}-${pick("day")}`;
      const time =
        intent.data.time ||
        (pick("hour") && pick("minute")
          ? `${pick("hour")}:${pick("minute")}`
          : "09:00");
      reminderAt = parseReminderDateTime(`${date}T${time}`);
      if (!reminderAt || reminderAt.getTime() <= Date.now()) {
        return failureResponse(
          "update_reminder",
          "Новая дата напоминания должна находиться в будущем.",
          "invalid_date",
        );
      }
    }

    const [updated] = await db
      .update(itemsTable)
      .set({
        ...(intent.data.title ? { title: intent.data.title } : {}),
        ...(intent.data.content ? { content: intent.data.content } : {}),
        reminderAt,
      })
      .where(
        and(
          eq(itemsTable.id, target.id),
          eq(itemsTable.userId, userId),
          eq(itemsTable.type, "reminder"),
        ),
      )
      .returning();
    if (!updated) {
      return failureResponse(
        "update_reminder",
        "Не удалось изменить напоминание.",
        "not_found",
      );
    }
    const dateText = updated.reminderAt
      ? ` на ${formatMoscowDateTime(updated.reminderAt)}`
      : "";
    return baseResponse(
      "update_reminder",
      `Напоминание изменено: «${updated.title}»${dateText}.`,
    );
  }

  if (intent.intent === "move_item_to_folder") {
    const folder = findFolder(folders, intent.data.folderName);
    if (!folder) {
      return failureResponse(
        "move_item_to_folder",
        `Я не нашёл папку «${intent.data.folderName}».`,
        "folder_not_found",
      );
    }
    const { target, candidates } = await resolveMutationTarget(
      intent.data.itemQuery,
      intent.data.itemType,
    );
    if (candidates.length > 1) {
      return targetSelectionResponse("move_item_to_folder", candidates);
    }
    if (!target) {
      return failureResponse(
        "move_item_to_folder",
        `Я не нашёл объект по запросу «${intent.data.itemQuery}».`,
        "not_found",
      );
    }
    const [updated] = await db
      .update(itemsTable)
      .set({ folderId: folder.id })
      .where(and(eq(itemsTable.id, target.id), eq(itemsTable.userId, userId)))
      .returning();
    if (!updated) {
      return failureResponse(
        "move_item_to_folder",
        "Не удалось переместить объект.",
        "not_found",
      );
    }
    return baseResponse(
      "move_item_to_folder",
      `«${itemTitle(updated)}» перемещён в папку «${folder.name}».`,
    );
  }

  if (intent.intent === "delete_item") {
    if (intent.data.itemType === "folder") {
      const folder = findFolder(folders, intent.data.itemQuery);
      if (!folder) {
        return failureResponse(
          "delete_folder",
          `Я не нашёл папку «${intent.data.itemQuery}».`,
          "not_found",
        );
      }
      if (folder.isSystem) {
        return failureResponse(
          "delete_folder",
          "Системную папку нельзя удалить.",
          "system_folder",
        );
      }
      await db.transaction(async (tx) => {
        await tx
          .update(itemsTable)
          .set({ folderId: null })
          .where(
            and(
              eq(itemsTable.folderId, folder.id),
              eq(itemsTable.userId, userId),
            ),
          );
        await tx
          .delete(foldersTable)
          .where(
            and(
              eq(foldersTable.id, folder.id),
              eq(foldersTable.userId, userId),
            ),
          );
      });
      return baseResponse("delete_folder", `Папка удалена: «${folder.name}».`);
    }

    const itemType = intent.data.itemType;
    const { target, candidates } = await resolveMutationTarget(
      intent.data.itemQuery,
      itemType,
    );
    if (candidates.length > 1) {
      return targetSelectionResponse("unknown_or_ambiguous", candidates);
    }
    if (!target) {
      return failureResponse(
        "unknown_or_ambiguous",
        `Я не нашёл объект по запросу «${intent.data.itemQuery}».`,
        "not_found",
      );
    }
    const [deleted] = await db
      .delete(itemsTable)
      .where(and(eq(itemsTable.id, target.id), eq(itemsTable.userId, userId)))
      .returning();
    if (!deleted) {
      return failureResponse(
        `delete_${target.type}` as AssistantActionIntent,
        "Не удалось удалить объект.",
        "not_found",
      );
    }
    return baseResponse(
      `delete_${target.type}` as AssistantActionIntent,
      `Удалено: «${itemTitle(deleted)}».`,
    );
  }

  if (intent.intent === "rename_folder") {
    const folder = findFolder(folders, intent.data.folderName);
    if (!folder) {
      return failureResponse(
        "rename_folder",
        `Я не нашёл папку «${intent.data.folderName}».`,
        "not_found",
      );
    }
    if (folder.isSystem) {
      return failureResponse(
        "rename_folder",
        "Системную папку нельзя переименовать.",
        "system_folder",
      );
    }
    const [updated] = await db
      .update(foldersTable)
      .set({ name: intent.data.newName })
      .where(
        and(eq(foldersTable.id, folder.id), eq(foldersTable.userId, userId)),
      )
      .returning();
    if (!updated) {
      return failureResponse(
        "rename_folder",
        "Не удалось переименовать папку.",
        "not_found",
      );
    }
    return baseResponse(
      "rename_folder",
      `Папка переименована в «${updated.name}».`,
    );
  }

  if (intent.intent === "create_folder") {
    const existing = findFolder(folders, intent.data.name);
    if (existing) {
      return failureResponse(
        "create_folder",
        `Папка «${existing.name}» уже есть.`,
        "already_exists",
      );
    }
    const [folder] = await db
      .insert(foldersTable)
      .values({ userId, name: intent.data.name, isSystem: false })
      .returning();
    if (!folder) throw new Error("Folder insert did not return a record");
    return baseResponse(
      "create_folder",
      `Готово: создал папку «${folder.name}».`,
    );
  }

  if (intent.intent === "search_items") {
    const items =
      providedItems ??
      (await db
        .select()
        .from(itemsTable)
        .where(
          and(eq(itemsTable.userId, userId), eq(itemsTable.status, "active")),
        )
        .orderBy(desc(itemsTable.updatedAt))
        .limit(1000));
    const requestedTypes = intent.data.types;
    const itemTypes = requestedTypes?.filter(
      (type): type is AssistantItemType => type !== "folder",
    ) ?? [];
    const matches = searchItems(items, intent.data.query).filter(
      (item) => !itemTypes || itemTypes.length === 0 || itemTypes.includes(item.type),
    );
    const sections: string[] = [];
    if (!requestedTypes || itemTypes.length > 0) {
      sections.push(
        listItemsMessage("Найденные материалы", matches, folders),
      );
    }
    if (requestedTypes?.includes("folder")) {
      const query = normalizeText(intent.data.query);
      const folderMatches = folders.filter((folder) =>
        normalizeText(folder.name).includes(query),
      );
      sections.push(
        folderMatches.length > 0
          ? ["Найденные папки:", ...folderMatches.map((folder, index) => `${index + 1}. ${folder.name}`)].join("\n")
          : "Найденные папки: ничего не найдено.",
      );
    }
    return baseResponse("search_user_content", sections.join("\n\n"));
  }

  return failureResponse(
    "unknown_or_ambiguous",
    "Уточните действие, которое нужно выполнить.",
    "clarification_required",
  );
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
  if (pending?.action === "create_reminder") {
    logger.info({ ...logBase, intent: pending.action }, "[assistant] continuing pending reminder action");
    return continuePendingReminderAction({ userId, action: pending, content, folders, folderId });
  }
  if (pending && CONFIRM_RE.test(normalized)) {
    logger.info({ ...logBase, intent: pending.action }, "[assistant] executing confirmed pending action");
    return executePendingAction(userId, pending, folders);
  }
  if (pending && CANCEL_RE.test(normalized)) {
    logger.info({ ...logBase, intent: pending.action }, "[assistant] pending action cancelled");
    return failureResponse("unknown_or_ambiguous", "Ок, действие отменено.", "cancelled");
  }

  const keywordCommand = getKeywordCommand(content);
  if (keywordCommand) {
    const result = await executeKeywordCommand({
      command: keywordCommand,
      userId,
      folders,
      folderId,
    });
    logger.info(
      {
        ...logBase,
        intent: result.intentType,
        responseMode: result.responseMode,
        savedItemTitle: result.assistantContext.savedItem?.title ?? null,
      },
      "[assistant] keyword command handled",
    );
    return result;
  }

  if (/очисти\s+(чат|историю)|удали\s+историю\s+чата/i.test(normalized)) {
    if (!conversationId) return failureResponse("clear_chat", "Не удалось очистить чат: текущий чат не найден.", "not_found");
    return withPending(
      "clear_chat",
      "Очистить историю чата? Это удалит только сообщения, заметки/файлы/папки/напоминания останутся. Ответьте «да», чтобы подтвердить.",
      { action: "clear_chat", conversationId },
    );
  }

  if (SEARCH_RE.test(normalized)) {
    const query = extractSearchQuery(content);
    if (NOTE_WORD_RE.test(normalized)) {
      const notes = query ? searchItems(items, query, "note") : items.filter((item) => item.type === "note");
      return baseResponse("search_user_content", listItemsMessage("Ваши заметки", notes, folders));
    }
    if (FILE_WORD_RE.test(normalized)) {
      const files = query ? searchItems(items, query, "file") : items.filter((item) => item.type === "file");
      return baseResponse("search_files", listItemsMessage("Ваши файлы", files, folders));
    }
    if (REMINDER_WORD_RE.test(normalized)) {
      const reminders = query ? searchItems(items, query, "reminder") : items.filter((item) => item.type === "reminder");
      return baseResponse("search_reminders", listItemsMessage("Ваши напоминания", reminders, folders));
    }
    if (LIST_WORD_RE.test(normalized)) {
      const lists = query ? searchItems(items, query, "list") : items.filter((item) => item.type === "list");
      return baseResponse("search_user_content", listItemsMessage("Ваши списки", lists, folders));
    }
    if (FOLDER_WORD_RE.test(normalized)) {
      const message =
        folders.length === 0
          ? "У вас пока нет папок."
          : ["Ваши папки:", ...folders.map((folder, index) => `${index + 1}. ${folder.name}`)].join("\n");
      return baseResponse("search_user_content", message);
    }

    const matches = searchItems(items, query);
    return baseResponse("search_user_content", listItemsMessage("Найденные материалы", matches, folders));
  }

  if (/создай\s+папк|добавь\s+папк/i.test(normalized)) {
    const folderName = extractTarget(content, "folder") || compact(content.replace(/создай|добавь|папк[ауи]?/gi, ""));
    if (!folderName) return failureResponse("unknown_or_ambiguous", "Как назвать новую папку?", "clarification_required");
    const existing = findFolder(folders, folderName);
    if (existing) return failureResponse("create_folder", `Папка «${existing.name}» уже есть.`, "already_exists");
    const [folder] = await db.insert(foldersTable).values({ userId, name: folderName, isSystem: false }).returning();
    logger.info({ ...logBase, intent: "create_folder", folderId: folder.id }, "[assistant] action success");
    return baseResponse("create_folder", `Готово: создал папку «${folder.name}».`);
  }

  if (/переименуй\s+папк|измени\s+название\s+папк/i.test(normalized)) {
    const oldName = extractBetween(content, /папк[ауи]?\s+/i, /\s+(?:в|на)\s+/i);
    const newName = /(?:в|на)\s+["«]?([^"».,!?]+)["»]?/i.exec(content)?.[1];
    const folder = findFolder(folders, oldName);
    if (!folder) return failureResponse("rename_folder", `Я не нашел папку${oldName ? ` «${oldName}»` : ""}.`, "not_found");
    if (folder.isSystem) return failureResponse("rename_folder", "Системные папки нельзя переименовывать.", "system_folder");
    if (!newName) return failureResponse("rename_folder", `Как назвать папку «${folder.name}»?`, "clarification_required");
    const [updated] = await db.update(foldersTable).set({ name: compact(newName) }).where(and(eq(foldersTable.id, folder.id), eq(foldersTable.userId, userId))).returning();
    return baseResponse("rename_folder", `Готово: переименовал папку «${folder.name}» в «${updated.name}».`);
  }

  if (DELETE_RE.test(normalized) && FOLDER_WORD_RE.test(normalized)) {
    const target = extractTarget(content, "folder");
    const folder = findFolder(folders, target);
    if (!folder) return failureResponse("delete_folder", `Я не нашел папку${target ? ` «${target}»` : ""}.`, "not_found");
    if (folder.isSystem) return failureResponse("delete_folder", "Системные папки нельзя удалять.", "system_folder");
    await db.transaction(async (tx) => {
      await tx
        .update(itemsTable)
        .set({ folderId: null })
        .where(
          and(
            eq(itemsTable.folderId, folder.id),
            eq(itemsTable.userId, userId),
          ),
        );
      await tx
        .delete(foldersTable)
        .where(
          and(
            eq(foldersTable.id, folder.id),
            eq(foldersTable.userId, userId),
          ),
        );
    });
    return baseResponse("delete_folder", `Папка удалена: «${folder.name}».`);
  }

  if (looksLikeReminderCandidate(content)) {
    return withSuggestedActions(
      "Что сделать с этим сообщением?",
      ["save_reminder", "save_note", "ignore"],
      content,
    );
  }

  if (looksLikeListCandidate(content)) {
    return withSuggestedActions(
      "Что сделать с этим сообщением?",
      ["create_list", "save_note", "ignore"],
      content,
    );
  }

  if (LEGACY_AUTO_SAVE_ENABLED && CREATE_NOTE_RE.test(normalized)) {
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

  if (LEGACY_AUTO_SAVE_ENABLED && (CREATE_REMINDER_RE.test(normalized) || (/(завтра|послезавтра|сегодня|\d{1,2}[:.]\d{2})/i.test(normalized) && !/(помоги|объясни|какие|найди|покажи)/i.test(normalized)))) {
    const remindAt = parseRussianDateTime(content);
    const folder = findFolder(folders, extractFolderName(content)) ?? (folderId ? folders.find((entry) => entry.id === folderId) ?? null : null);
    const text = stripFolderMention(removeDateWords(extractCreateContent(content, content)).replace(/^(напомни|не\s+забыть)\s*/i, ""));
    if (!remindAt && CREATE_REMINDER_RE.test(normalized)) {
      return failureResponse("unknown_or_ambiguous", "Когда поставить напоминание? Укажите дату и время, например: завтра в 10:00.", "clarification_required");
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
    if (!remindAt) return failureResponse("update_reminder", "На какую дату и время перенести напоминание?", "clarification_required");
    const matches = searchItems(items, target, "reminder");
    if (matches.length === 0) return failureResponse("update_reminder", `Я не нашел напоминание${target ? ` про «${compact(target)}»` : ""}. Могу создать новое.`, "not_found");
    if (matches.length > 1) return failureResponse("update_reminder", listItemsMessage("Я нашел несколько напоминаний, уточните какое изменить", matches, folders), "ambiguous");
    const [updated] = await db
      .update(itemsTable)
      .set({ reminderAt: remindAt })
      .where(and(eq(itemsTable.id, matches[0].id), eq(itemsTable.userId, userId), eq(itemsTable.type, "reminder")))
      .returning();
    if (!updated) return failureResponse("update_reminder", "Не удалось изменить напоминание: объект не найден.", "not_found");
    return baseResponse("update_reminder", `Готово: перенес напоминание «${updated.title}» на ${formatMoscowDateTime(remindAt)}.`);
  }

  if (DELETE_RE.test(normalized) && (NOTE_WORD_RE.test(normalized) || FILE_WORD_RE.test(normalized) || REMINDER_WORD_RE.test(normalized) || LIST_WORD_RE.test(normalized))) {
    const type = NOTE_WORD_RE.test(normalized) ? "note" : FILE_WORD_RE.test(normalized) ? "file" : LIST_WORD_RE.test(normalized) ? "list" : "reminder";
    const target = extractTarget(content, type);
    const matches = searchItems(items, target, type);
    if (matches.length === 0) return failureResponse(`delete_${type}` as AssistantActionIntent, `Я не нашел ${type === "note" ? "заметку" : type === "file" ? "файл" : type === "list" ? "список" : "напоминание"}${target ? ` «${target}»` : ""}.`, "not_found");
    if (matches.length > 1) return failureResponse(`delete_${type}` as AssistantActionIntent, listItemsMessage("Нашел несколько объектов, уточните какой удалить", matches, folders), "ambiguous");
    const item = matches[0];
    const [deleted] = await db
      .delete(itemsTable)
      .where(and(eq(itemsTable.id, item.id), eq(itemsTable.userId, userId)))
      .returning();
    if (!deleted) {
      return failureResponse(
        `delete_${type}` as AssistantActionIntent,
        "Не удалось удалить объект.",
        "not_found",
      );
    }
    return baseResponse(
      `delete_${type}` as AssistantActionIntent,
      `Удалено: «${itemTitle(deleted)}».`,
    );
  }

  if (/перемест|перенеси|добавь.+в\s+папк/i.test(normalized)) {
    const folder = findFolder(folders, extractFolderName(content));
    if (!folder) return failureResponse("move_item_to_folder", "Я не нашел целевую папку. Уточните название папки или создайте её.", "not_found");
    const type = NOTE_WORD_RE.test(normalized) ? "note" : FILE_WORD_RE.test(normalized) ? "file" : REMINDER_WORD_RE.test(normalized) ? "reminder" : LIST_WORD_RE.test(normalized) ? "list" : undefined;
    const target = type ? extractTarget(content, type) : extractTarget(content, "item");
    const matches = searchItems(items, target, type);
    if (matches.length === 0) return failureResponse("move_item_to_folder", `Я не нашел объект${target ? ` «${target}»` : ""}.`, "not_found");
    if (matches.length > 1) return failureResponse("move_item_to_folder", listItemsMessage("Нашел несколько объектов, уточните какой переместить", matches, folders), "ambiguous");
    const [updated] = await db.update(itemsTable).set({ folderId: folder.id }).where(and(eq(itemsTable.id, matches[0].id), eq(itemsTable.userId, userId))).returning();
    if (!updated) return failureResponse("move_item_to_folder", "Не удалось переместить объект: он не найден.", "not_found");
    return baseResponse("move_item_to_folder", `Готово: переместил «${itemTitle(updated)}» в папку «${folder.name}».`);
  }

  if (UPDATE_RE.test(normalized) && NOTE_WORD_RE.test(normalized)) {
    return failureResponse("update_note", "Чтобы изменить заметку, укажите её название и новый текст. Например: «измени заметку про адаптив: новый текст...».", "clarification_required");
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
