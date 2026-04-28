import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { conversations, db, foldersTable, itemsTable, messages, type Item } from "@workspace/db";
import { logger } from "./logger";

type SourceType = "folder" | "note" | "file" | "reminder" | "message";

export interface UserContextData {
  overview: {
    folderCount: number;
    noteCount: number;
    fileCount: number;
    reminderCount: number;
  };
  folders: Array<{
    id: number;
    name: string;
    itemCount: number;
  }>;
  recentNotes: Array<ContextItem>;
  recentFiles: Array<ContextItem & { filename: string; mimeType: string; size: string }>;
  upcomingReminders: Array<ContextItem & { dueDate: string; status: string }>;
  relevantSources: Array<RelevantSource>;
}

interface ContextItem {
  type: Extract<SourceType, "note" | "file" | "reminder">;
  title: string;
  folder: string;
  date: string;
  excerpt: string;
}

interface RelevantSource {
  type: SourceType;
  title: string;
  folder?: string;
  date?: string;
  excerpt: string;
  score: number;
}

const SEARCH_STOP_WORDS = new Set([
  "что",
  "где",
  "как",
  "когда",
  "какие",
  "какая",
  "какой",
  "меня",
  "мои",
  "мой",
  "моя",
  "мое",
  "мною",
  "про",
  "для",
  "или",
  "это",
  "найди",
  "найти",
  "покажи",
  "скажи",
  "перескажи",
  "сохраненных",
  "сохраненные",
  "данных",
]);

const SAVED_DATA_QUERY_RE =
  /(сохранял|сохраненн|заметк|файл|папк|напомин|найди|покажи|перескажи|что у меня|какие у меня|в моих|из моих|mindvault|баз[аеы] знаний)/i;

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е");
}

function getSearchTerms(query: string): string[] {
  const normalized = normalizeText(query);
  return Array.from(
    new Set(
      normalized
        .split(/[^\p{L}\p{N}_-]+/u)
        .map((word) => word.trim())
        .filter((word) => word.length > 2 && !SEARCH_STOP_WORDS.has(word)),
    ),
  ).slice(0, 16);
}

function truncateText(value: string | null | undefined, maxLength: number): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function formatDate(value: Date | null | undefined): string {
  return value
    ? value.toLocaleDateString("ru-RU", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "дата не указана";
}

function formatDateTime(value: Date | null | undefined): string {
  return value
    ? value.toLocaleString("ru-RU", {
        timeZone: "Europe/Moscow",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "дата не указана";
}

function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${Math.round(size * 10) / 10} ${units[unitIndex]}`;
}

function isTextLikeFile(mimeType: string | null | undefined, filename: string | null | undefined): boolean {
  const mime = (mimeType ?? "").toLowerCase();
  const extension = (filename ?? "").split(".").pop()?.toLowerCase() ?? "";
  const textExtensions = new Set(["txt", "md", "csv", "json", "xml", "yml", "yaml", "log", "html", "css", "js", "ts"]);
  return mime.startsWith("text/") || mime.includes("json") || mime.includes("xml") || textExtensions.has(extension);
}

function extractTextPreview(item: Item, maxLength = 900): string {
  if (item.content?.trim()) return truncateText(item.content, maxLength);

  if (item.type === "file" && item.fileData && isTextLikeFile(item.mimeType, item.originalFilename ?? item.title)) {
    try {
      const decoded = Buffer.from(item.fileData, "base64").toString("utf8");
      const cleaned = decoded.replace(/\u0000/g, "").trim();
      const suspiciousChars = cleaned.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g)?.length ?? 0;
      if (cleaned && suspiciousChars / cleaned.length < 0.02) {
        return truncateText(cleaned, maxLength);
      }
    } catch (err) {
      logger.debug({ err, itemId: item.id }, "Could not decode text preview for assistant context");
    }
  }

  if (item.type === "file") {
    return truncateText(
      [item.originalFilename ?? item.title, item.mimeType, formatFileSize(item.fileSize)].filter(Boolean).join(", "),
      maxLength,
    );
  }

  return "(пустое содержимое)";
}

function scoreText(query: string, terms: string[], fields: Array<{ value: string; weight: number }>): number {
  if (!query.trim() || terms.length === 0) return 0;

  const normalizedQuery = normalizeText(query);
  let score = 0;

  for (const field of fields) {
    const value = normalizeText(field.value);
    if (!value) continue;
    if (value === normalizedQuery) score += 120 * field.weight;
    if (value.includes(normalizedQuery)) score += 45 * field.weight;

    for (const term of terms) {
      if (value.includes(term)) score += 8 * field.weight;
    }
  }

  return score;
}

function scoreItem(query: string, terms: string[], item: Item, folderName: string): number {
  return scoreText(query, terms, [
    { value: item.title, weight: 3 },
    { value: item.originalFilename ?? "", weight: 3 },
    { value: folderName, weight: 2 },
    { value: item.summary ?? "", weight: 2 },
    { value: item.content ?? "", weight: 1 },
    { value: item.type, weight: 1 },
  ]);
}

export async function buildAssistantContext(
  userId: number,
  currentMessage: string,
  conversationId?: number,
  options?: {
    maxRecentItems?: number;
    maxSearchResults?: number;
    includeArchived?: boolean;
  },
): Promise<UserContextData> {
  const maxRecentItems = options?.maxRecentItems ?? 10;
  const maxSearchResults = options?.maxSearchResults ?? 20;
  const includeArchived = options?.includeArchived ?? false;

  try {
    const folders = await db.select().from(foldersTable).where(eq(foldersTable.userId, userId));
    const folderMap = new Map(folders.map((folder) => [folder.id, folder.name]));

    const itemConditions = [eq(itemsTable.userId, userId)];
    if (!includeArchived) itemConditions.push(eq(itemsTable.status, "active"));

    const allItems = await db
      .select()
      .from(itemsTable)
      .where(and(...itemConditions))
      .orderBy(desc(itemsTable.updatedAt))
      .limit(1000);

    const folderCounts = new Map<number, number>();
    for (const item of allItems) {
      if (item.folderId) {
        folderCounts.set(item.folderId, (folderCounts.get(item.folderId) ?? 0) + 1);
      }
    }

    const userFolders = folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      itemCount: folderCounts.get(folder.id) ?? 0,
    }));

    const notes = allItems.filter((item) => item.type === "note");
    const files = allItems.filter((item) => item.type === "file");
    const reminders = allItems.filter((item) => item.type === "reminder");

    const recentNotes = notes.slice(0, maxRecentItems).map((item) => ({
      type: "note" as const,
      title: item.title,
      excerpt: extractTextPreview(item, 280),
      folder: folderMap.get(item.folderId ?? 0) ?? "Без папки",
      date: formatDate(item.updatedAt),
    }));

    const recentFiles = files.slice(0, maxRecentItems).map((item) => ({
      type: "file" as const,
      title: item.title,
      filename: item.originalFilename ?? item.title,
      mimeType: item.mimeType ?? "application/octet-stream",
      size: formatFileSize(item.fileSize),
      folder: folderMap.get(item.folderId ?? 0) ?? "Без папки",
      date: formatDate(item.updatedAt),
      excerpt: extractTextPreview(item, 360),
    }));

    const now = new Date();
    const upcomingReminders = reminders
      .filter((item) => item.status !== "completed" && (!item.reminderAt || item.reminderAt >= now))
      .slice(0, maxRecentItems)
      .map((item) => ({
        type: "reminder" as const,
        title: item.title,
        dueDate: formatDateTime(item.reminderAt),
        status: item.status,
        folder: folderMap.get(item.folderId ?? 0) ?? "Без папки",
        date: formatDate(item.updatedAt),
        excerpt: extractTextPreview(item, 220),
      }));

    const conversationRows = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.userId, userId))
      .orderBy(desc(conversations.updatedAt))
      .limit(50);
    const conversationIds = conversationRows.map((conversation) => conversation.id);

    const recentMessages =
      conversationIds.length > 0
        ? await db
            .select({
              id: messages.id,
              conversationId: messages.conversationId,
              role: messages.role,
              content: messages.content,
              createdAt: messages.createdAt,
            })
            .from(messages)
            .where(inArray(messages.conversationId, conversationIds))
            .orderBy(desc(messages.createdAt))
            .limit(400)
        : [];

    const terms = getSearchTerms(currentMessage);
    const relevantSources: RelevantSource[] = [];

    for (const folder of userFolders) {
      const score = scoreText(currentMessage, terms, [{ value: folder.name, weight: 4 }]);
      if (score > 0) {
        relevantSources.push({
          type: "folder",
          title: folder.name,
          excerpt: `Папка пользователя, объектов: ${folder.itemCount}`,
          score,
        });
      }
    }

    for (const item of allItems) {
      const folder = folderMap.get(item.folderId ?? 0) ?? "Без папки";
      const score = scoreItem(currentMessage, terms, item, folder);
      if (score > 0) {
        relevantSources.push({
          type: item.type,
          title: item.type === "file" ? item.originalFilename ?? item.title : item.title,
          folder,
          date: formatDate(item.updatedAt),
          excerpt: extractTextPreview(item),
          score,
        });
      }
    }

    for (const message of recentMessages) {
      if (conversationId && message.conversationId === conversationId) continue;
      const score = scoreText(currentMessage, terms, [{ value: message.content, weight: 1 }]);
      if (score > 0) {
        relevantSources.push({
          type: "message",
          title: message.role === "assistant" ? "Ответ ассистента из другого чата" : "Сообщение пользователя из другого чата",
          date: formatDate(message.createdAt),
          excerpt: truncateText(message.content, 500),
          score,
        });
      }
    }

    return {
      overview: {
        folderCount: folders.length,
        noteCount: notes.length,
        fileCount: files.length,
        reminderCount: reminders.length,
      },
      folders: userFolders,
      recentNotes,
      recentFiles,
      upcomingReminders,
      relevantSources: relevantSources
        .sort((a, b) => b.score - a.score)
        .slice(0, maxSearchResults),
    };
  } catch (err) {
    logger.error({ err }, "Failed to build assistant context");
    return {
      overview: { folderCount: 0, noteCount: 0, fileCount: 0, reminderCount: 0 },
      folders: [],
      recentNotes: [],
      recentFiles: [],
      upcomingReminders: [],
      relevantSources: [],
    };
  }
}

export function formatContextForPrompt(context: UserContextData, includeEverything = false): string {
  const sections: string[] = [];

  sections.push(
    [
      "Overview:",
      `- Folders: ${context.overview.folderCount}`,
      `- Notes: ${context.overview.noteCount}`,
      `- Files: ${context.overview.fileCount}`,
      `- Reminders: ${context.overview.reminderCount}`,
    ].join("\n"),
  );

  if (context.folders.length > 0) {
    sections.push(
      [
        "Folders:",
        ...context.folders
          .slice(0, 30)
          .map((folder) => `- ${folder.name} (${folder.itemCount} objects)`),
      ].join("\n"),
    );
  }

  if (context.relevantSources.length > 0) {
    sections.push(
      [
        "Relevant sources found by MindVault search:",
        ...context.relevantSources.map((source, index) => {
          const folder = source.folder ? `, folder: ${source.folder}` : "";
          const date = source.date ? `, date: ${source.date}` : "";
          return `${index + 1}. [${source.type}] ${source.title}${folder}${date}\n   ${source.excerpt}`;
        }),
      ].join("\n"),
    );
  }

  if (includeEverything || context.relevantSources.length === 0) {
    if (context.recentNotes.length > 0) {
      sections.push(
        [
          "Recent notes:",
          ...context.recentNotes.map((note) => `- ${note.title} (${note.folder}, ${note.date}): ${note.excerpt}`),
        ].join("\n"),
      );
    }

    if (context.recentFiles.length > 0) {
      sections.push(
        [
          "Recent files:",
          ...context.recentFiles.map(
            (file) =>
              `- ${file.filename} (${file.mimeType}, ${file.size}, ${file.folder}, ${file.date}): ${file.excerpt}`,
          ),
        ].join("\n"),
      );
    }

    if (context.upcomingReminders.length > 0) {
      sections.push(
        [
          "Upcoming reminders:",
          ...context.upcomingReminders.map(
            (reminder) => `- ${reminder.title}: ${reminder.dueDate} (${reminder.folder})`,
          ),
        ].join("\n"),
      );
    }
  }

  const asksAboutSavedData = SAVED_DATA_QUERY_RE.toString();

  return (
    "\n\n---\n" +
    "MindVault private user context. This data belongs only to the current authenticated user.\n" +
    "Use it when it is relevant to the user's question. Do not expose raw JSON or database details.\n" +
    "When you rely on saved notes, files, folders, reminders, or old chat messages, briefly name the source titles.\n" +
    "If the user asks about saved data and the relevant sources section is empty, say in Russian: \"В сохраненных данных я не нашел ничего похожего.\" Do not invent saved content.\n" +
    `Saved-data query detector used by the app: ${asksAboutSavedData}\n\n` +
    sections.join("\n\n") +
    "\n---\n"
  );
}
