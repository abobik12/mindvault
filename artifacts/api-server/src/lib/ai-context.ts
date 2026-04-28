import { and, desc, eq, inArray } from "drizzle-orm";
import { conversations, db, foldersTable, itemsTable, messages, type Item } from "@workspace/db";
import { logger } from "./logger";

type SourceType = "folder" | "note" | "file" | "reminder" | "message";
type QueryIntent = "notes" | "files" | "folders" | "reminders" | "saved" | "topic" | "general";

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
  queryIntent: QueryIntent;
  requestedTypes: Array<"note" | "file" | "reminder" | "folder">;
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

const NOTE_QUERY_RE = /(заметк|запис|мысл)/i;
const FILE_QUERY_RE = /(файл|документ|загруз|вложен)/i;
const FOLDER_QUERY_RE = /(папк|раздел|каталог)/i;
const REMINDER_QUERY_RE = /(напомин|задач|срок|дедлайн|дел[ао])/i;
const SAVED_OVERVIEW_QUERY_RE = /(что\s+я\s+сохранял|что\s+сохранено|покажи\s+сохран|какие\s+у\s+меня|что\s+у\s+меня)/i;

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е");
}

function stemSearchTerm(word: string): string {
  return word.replace(/(ами|ями|ого|ему|ыми|ими|ая|яя|ое|ее|ые|ие|ий|ый|ой|ом|ем|ах|ях|ам|ям|ов|ев|ей|ую|юю|а|я|у|ю|е|ы|и|о)$/i, "");
}

function getSearchTerms(query: string): string[] {
  const normalized = normalizeText(query);
  const terms: string[] = [];
  for (const word of normalized
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 2 && !SEARCH_STOP_WORDS.has(entry))) {
    terms.push(word);
    const stemmed = stemSearchTerm(word);
    if (stemmed.length > 2 && stemmed !== word) terms.push(stemmed);
  }

  return Array.from(
    new Set(terms),
  ).slice(0, 16);
}

function getRequestedTypes(query: string): Array<"note" | "file" | "reminder" | "folder"> {
  const normalized = normalizeText(query);
  const types: Array<"note" | "file" | "reminder" | "folder"> = [];
  if (NOTE_QUERY_RE.test(normalized)) types.push("note");
  if (FILE_QUERY_RE.test(normalized)) types.push("file");
  if (FOLDER_QUERY_RE.test(normalized)) types.push("folder");
  if (REMINDER_QUERY_RE.test(normalized)) types.push("reminder");
  return types;
}

function detectQueryIntent(query: string): QueryIntent {
  const normalized = normalizeText(query);
  const requestedTypes = getRequestedTypes(normalized);
  if (requestedTypes.length > 1) return "saved";
  if (requestedTypes[0] === "note") return "notes";
  if (requestedTypes[0] === "file") return "files";
  if (requestedTypes[0] === "folder") return "folders";
  if (requestedTypes[0] === "reminder") return "reminders";
  if (SAVED_OVERVIEW_QUERY_RE.test(normalized) || SAVED_DATA_QUERY_RE.test(normalized)) return "saved";
  return getSearchTerms(query).length > 0 ? "topic" : "general";
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
    { value: Array.isArray(item.aiTags) ? item.aiTags.join(" ") : "", weight: 2 },
    { value: item.aiCategory ?? "", weight: 2 },
    { value: item.type, weight: 1 },
  ]);
}

function sourceFromItem(item: Item, folder: string, score: number): RelevantSource {
  return {
    type: item.type,
    title: item.type === "file" ? item.originalFilename ?? item.title : item.title,
    folder,
    date: formatDate(item.updatedAt),
    excerpt: extractTextPreview(item),
    score,
  };
}

function sourceKey(source: RelevantSource): string {
  return `${source.type}:${source.title}:${source.folder ?? ""}:${source.date ?? ""}`;
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
    const queryIntent = detectQueryIntent(currentMessage);
    const requestedTypes = getRequestedTypes(currentMessage);
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
      if (score > 0 || requestedTypes.includes("folder") || queryIntent === "folders" || queryIntent === "saved") {
        relevantSources.push({
          type: "folder",
          title: folder.name,
          excerpt: `Папка пользователя, объектов: ${folder.itemCount}`,
          score: score || (queryIntent === "folders" ? 80 : 30),
        });
      }
    }

    for (const item of allItems) {
      const folder = folderMap.get(item.folderId ?? 0) ?? "Без папки";
      const score = scoreItem(currentMessage, terms, item, folder);
      const shouldIncludeByIntent =
        queryIntent === "saved" ||
        requestedTypes.includes(item.type) ||
        (queryIntent === "notes" && item.type === "note") ||
        (queryIntent === "files" && item.type === "file") ||
        (queryIntent === "reminders" && item.type === "reminder");

      if (score > 0 || shouldIncludeByIntent) {
        relevantSources.push(sourceFromItem(item, folder, score || (shouldIncludeByIntent ? 75 : 0)));
      }
    }

    const matchedFolderIds = new Set(
      userFolders
        .filter((folder) => scoreText(currentMessage, terms, [{ value: folder.name, weight: 4 }]) > 0)
        .map((folder) => folder.id),
    );
    if (matchedFolderIds.size > 0) {
      for (const item of allItems.filter((entry) => entry.folderId && matchedFolderIds.has(entry.folderId))) {
        const folder = folderMap.get(item.folderId ?? 0) ?? "Без папки";
        relevantSources.push(sourceFromItem(item, folder, 65));
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

    const uniqueRelevantSources = Array.from(
      new Map(
        relevantSources
          .sort((a, b) => b.score - a.score)
          .map((source) => [sourceKey(source), source] as const),
      ).values(),
    ).slice(0, maxSearchResults);

    logger.info(
      {
        userId,
        conversationId,
        queryIntent,
        requestedTypes,
        itemCount: allItems.length,
        noteCount: notes.length,
        fileCount: files.length,
        folderCount: folders.length,
        reminderCount: reminders.length,
        relevantCount: uniqueRelevantSources.length,
        sourceTitles: uniqueRelevantSources.map((source) => source.title).slice(0, 20),
      },
      "[assistant-context] collected user content",
    );

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
      relevantSources: uniqueRelevantSources,
      queryIntent,
      requestedTypes,
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
      queryIntent: "general",
      requestedTypes: [],
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
  const hasAnySavedData =
    context.overview.folderCount + context.overview.noteCount + context.overview.fileCount + context.overview.reminderCount > 0;

  return (
    "\n\n---\n" +
    "MindVault private user context. This data belongs only to the current authenticated user.\n" +
    "Use it when it is relevant to the user's question. Do not expose raw JSON or database details.\n" +
    "When you rely on saved notes, files, folders, reminders, or old chat messages, briefly name the source titles.\n" +
    `Detected user-content query intent: ${context.queryIntent}. Saved data exists: ${hasAnySavedData ? "yes" : "no"}.\n` +
    `Requested content types: ${context.requestedTypes.length > 0 ? context.requestedTypes.join(", ") : "not explicit"}.\n` +
    "If the user asks to list notes, files, folders, or reminders, answer from the matching sections even when keyword relevance is broad.\n" +
    "Say in Russian \"В сохраненных данных я не нашел ничего похожего.\" only when the user asks about saved data and no matching sources, recent items, or folders are present.\n" +
    `Saved-data query detector used by the app: ${asksAboutSavedData}\n\n` +
    sections.join("\n\n") +
    "\n---\n"
  );
}
