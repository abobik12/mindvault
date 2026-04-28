import { and, eq, desc, like, or, sql } from "drizzle-orm";
import { db, itemsTable, foldersTable, type Item } from "@workspace/db";
import { logger } from "./logger";

export interface UserContextData {
  folders: Array<{
    id: number;
    name: string;
    itemCount: number;
  }>;
  recentNotes: Array<{
    title: string;
    excerpt: string;
    folder: string;
    date: string;
  }>;
  recentFiles: Array<{
    title: string;
    filename: string;
    mimeType: string;
    size: string;
    folder: string;
    date: string;
    preview?: string;
  }>;
  upcomingReminders: Array<{
    title: string;
    dueDate: string;
    status: string;
    folder: string;
  }>;
  relevantItems: Array<{
    type: "note" | "file" | "reminder";
    title: string;
    folder: string;
    date: string;
    excerpt: string;
  }>;
}

/**
 * Simple relevance search - looks for keywords in item title and content
 */
function searchRelevance(query: string, item: Item): number {
  if (!query.trim()) return 0;

  const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);
  const titleLower = item.title.toLowerCase();
  const contentLower = (item.content || "").toLowerCase();

  let score = 0;

  // Exact title match = high score
  if (titleLower === query.toLowerCase()) score += 100;
  else if (titleLower.includes(query.toLowerCase())) score += 50;

  // Word matches in title
  for (const word of queryWords) {
    if (titleLower.includes(word)) score += 10;
    if (contentLower.includes(word)) score += 5;
  }

  return score;
}

/**
 * Format file size for display
 */
function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${Math.round(size * 10) / 10} ${units[unitIndex]}`;
}

/**
 * Decode base64 file data safely and extract text preview
 */
function extractTextPreview(
  fileData: string | null | undefined,
  mimeType: string | null | undefined,
  content: string | null | undefined,
  filename: string | null | undefined,
): string {
  // If there's already extracted content, use it
  if (content?.trim()) {
    const preview = content.substring(0, 150);
    return preview.length === 150 ? preview + "..." : preview;
  }

  // If it's a text file, try to decode base64
  if (mimeType && fileData && /^text\/|json|xml/i.test(mimeType)) {
    try {
      const decoded = Buffer.from(fileData, "base64").toString("utf-8");
      const preview = decoded.substring(0, 150);
      return preview.length === 150 ? preview + "..." : preview;
    } catch (err) {
      logger.debug({ err }, "Could not decode file preview");
    }
  }

  // Fallback: filename and mime type
  if (filename || mimeType) {
    return `Файл: ${filename || "unnamed"} (${mimeType || "unknown"})`;
  }

  return "Содержимое недоступно";
}

/**
 * Build comprehensive user context for AI
 * Fetches folders, recent items, and searches for relevant items based on current message
 */
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
  const maxSearchResults = options?.maxSearchResults ?? 5;
  const includeArchived = options?.includeArchived ?? false;

  try {
    // 1. Fetch user folders with item counts
    const folders = await db.select().from(foldersTable).where(eq(foldersTable.userId, userId));

    const folderCounts: Record<number, number> = {};
    const baseConditions = [eq(itemsTable.userId, userId)];
    if (!includeArchived) {
      baseConditions.push(eq(itemsTable.status, "active"));
    }

    for (const folder of folders) {
      const [countResult] = await db
        .select({ count: sql<number>`count(*)` })
        .from(itemsTable)
        .where(and(...baseConditions, eq(itemsTable.folderId, folder.id)));
      folderCounts[folder.id] = countResult?.count ?? 0;
    }

    const userFolders = folders.map((f) => ({
      id: f.id,
      name: f.name,
      itemCount: folderCounts[f.id] ?? 0,
    }));

    // 2. Fetch all user items (will filter below)
    const allItems = await db
      .select()
      .from(itemsTable)
      .where(and(...baseConditions))
      .orderBy(desc(itemsTable.updatedAt))
      .limit(1000); // reasonable limit to avoid memory issues

    // 3. Filter by type and build summaries
    const notes = allItems.filter((item) => item.type === "note");
    const files = allItems.filter((item) => item.type === "file");
    const reminders = allItems.filter((item) => item.type === "reminder");

    const folderMap = new Map(folders.map((f) => [f.id, f.name]));

    const recentNotes = notes.slice(0, maxRecentItems).map((item) => ({
      title: item.title,
      excerpt: item.content ? item.content.substring(0, 100) : "(пусто)",
      folder: folderMap.get(item.folderId) || "Без папки",
      date: item.updatedAt?.toLocaleDateString("ru-RU") ?? "неизвестно",
    }));

    const recentFiles = files.slice(0, maxRecentItems).map((item) => ({
      title: item.title,
      filename: item.originalFilename || "unknown",
      mimeType: item.mimeType || "application/octet-stream",
      size: formatFileSize(item.fileSize),
      folder: folderMap.get(item.folderId) || "Без папки",
      date: item.updatedAt?.toLocaleDateString("ru-RU") ?? "неизвестно",
      preview: extractTextPreview(item.fileData, item.mimeType, item.content, item.originalFilename),
    }));

    // 4. Fetch upcoming reminders (next 30 days or active ones)
    const now = new Date();
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const upcomingReminders = reminders
      .filter((r) => {
        if (!r.reminderAt) return r.status !== "completed";
        return r.reminderAt > now && r.reminderAt <= thirtyDaysFromNow;
      })
      .slice(0, maxRecentItems)
      .map((item) => ({
        title: item.title,
        dueDate: item.reminderAt?.toLocaleDateString("ru-RU", {
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }) ?? "без даты",
        status: item.status,
        folder: folderMap.get(item.folderId) || "Без папки",
      }));

    // 5. Search for relevant items based on current message
    const relevantItems: Array<{
      type: "note" | "file" | "reminder";
      title: string;
      folder: string;
      date: string;
      excerpt: string;
    }> = [];

    if (currentMessage.trim().length > 0) {
      const scored = allItems.map((item) => ({
        item,
        score: searchRelevance(currentMessage, item),
      }));

      const topRelevant = scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxSearchResults);

      for (const { item } of topRelevant) {
        relevantItems.push({
          type: item.type,
          title: item.title,
          folder: folderMap.get(item.folderId) || "Без папки",
          date: item.updatedAt?.toLocaleDateString("ru-RU") ?? "неизвестно",
          excerpt:
            item.type === "file"
              ? extractTextPreview(item.fileData, item.mimeType, item.content, item.originalFilename)
              : item.content
                ? item.content.substring(0, 100)
                : "(пусто)",
        });
      }
    }

    return {
      folders: userFolders,
      recentNotes,
      recentFiles,
      upcomingReminders,
      relevantItems,
    };
  } catch (err) {
    logger.error({ err }, "Failed to build assistant context");
    return {
      folders: [],
      recentNotes: [],
      recentFiles: [],
      upcomingReminders: [],
      relevantItems: [],
    };
  }
}

/**
 * Format user context into a readable string for the AI
 */
export function formatContextForPrompt(context: UserContextData, includeEverything: boolean = false): string {
  const sections: string[] = [];

  // Folders overview
  if (context.folders.length > 0) {
    const folderList = context.folders.map((f) => `• ${f.name} (${f.itemCount} объектов)`).join("\n");
    sections.push(`📁 **Папки пользователя:**\n${folderList}`);
  }

  // Relevant items (if found)
  if (context.relevantItems.length > 0) {
    const relevantList = context.relevantItems
      .map(
        (item) =>
          `• [${item.type}] ${item.title} (${item.folder})\n  ${item.excerpt}`,
      )
      .join("\n");
    sections.push(
      `🔍 **Релевантные элементы из базы знаний:**\n${relevantList}\n(Используй эти данные в ответе)`,
    );
  }

  // Recent items (if no relevant items or if including everything)
  if (includeEverything || context.relevantItems.length === 0) {
    if (context.recentNotes.length > 0) {
      const notesList = context.recentNotes
        .map((n) => `• ${n.title} (${n.folder})\n  ${n.excerpt}`)
        .join("\n");
      sections.push(`📝 **Последние заметки:**\n${notesList}`);
    }

    if (context.recentFiles.length > 0) {
      const filesList = context.recentFiles
        .map((f) => `• ${f.title} (${f.filename}, ${f.size})\n  ${f.preview}`)
        .join("\n");
      sections.push(`📄 **Последние файлы:**\n${filesList}`);
    }

    if (context.upcomingReminders.length > 0) {
      const remindersList = context.upcomingReminders
        .map((r) => `• ${r.title} — ${r.dueDate} (${r.folder})`)
        .join("\n");
      sections.push(`⏰ **Ближайшие напоминания:**\n${remindersList}`);
    }
  }

  if (sections.length === 0) {
    return "";
  }

  return (
    "\n\n---\n" +
    "**📚 Контекст из MindVault (личная база знаний пользователя):**\n\n" +
    sections.join("\n\n") +
    "\n\nИспользуй этот контекст при ответе, если он релевантен вопросу.\n" +
    "Если пользователь спрашивает о сохраненных данных, опирайся на информацию выше.\n" +
    "Если данных нет или они не подходят, скажи честно, что такой информации не найдено в базе."
  );
}
