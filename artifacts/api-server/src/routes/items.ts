import { Router, type IRouter } from "express";
import { eq, and, desc, asc, ilike, or, sql } from "drizzle-orm";
import { db, itemsTable, foldersTable } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { parseReminderDateTime } from "../lib/time";
import {
  ListItemsQueryParams,
  CreateItemBody,
  GetItemParams,
  UpdateItemParams,
  UpdateItemBody,
  DeleteItemParams,
  UploadFileBody,
  SearchItemsQueryParams,
  GetRecentItemsQueryParams,
  GetUpcomingRemindersQueryParams,
} from "@workspace/api-zod";
import { extractTextFromUpload } from "../lib/file-extraction";

const router: IRouter = Router();

async function folderBelongsToUser(userId: number, folderId: number): Promise<boolean> {
  const [folder] = await db
    .select({ id: foldersTable.id })
    .from(foldersTable)
    .where(and(eq(foldersTable.id, folderId), eq(foldersTable.userId, userId)))
    .limit(1);

  return Boolean(folder);
}

// Helper to build item response with folder name
async function itemWithFolder(item: typeof itemsTable.$inferSelect) {
  let folderName: string | null = null;
  if (item.folderId) {
    const [folder] = await db
      .select({ name: foldersTable.name })
      .from(foldersTable)
      .where(and(eq(foldersTable.id, item.folderId), eq(foldersTable.userId, item.userId)))
      .limit(1);
    folderName = folder?.name ?? null;
  }

  return {
    id: item.id,
    userId: item.userId,
    folderId: item.folderId ?? null,
    folderName,
    type: item.type,
    title: item.title,
    content: item.content ?? null,
    summary: item.summary ?? null,
    originalFilename: item.originalFilename ?? null,
    mimeType: item.mimeType ?? null,
    fileSize: item.fileSize ?? null,
    fileData: item.fileData ?? null,
    reminderAt: item.reminderAt ? item.reminderAt.toISOString() : null,
    status: item.status,
    aiCategory: item.aiCategory ?? null,
    aiTags: (item.aiTags as string[]) ?? [],
    aiConfidence: item.aiConfidence ?? null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

// GET /items
router.get("/items", requireAuth, async (req, res): Promise<void> => {
  const params = ListItemsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const { type, folderId, status, limit = 50, offset = 0 } = params.data;
  const userId = req.auth!.userId;

  if (folderId !== undefined && folderId !== null) {
    const hasAccess = await folderBelongsToUser(userId, folderId);
    if (!hasAccess) {
      res.status(404).json({ error: "Папка не найдена" });
      return;
    }
  }

  const conditions = [eq(itemsTable.userId, userId)];
  if (type) conditions.push(eq(itemsTable.type, type as "note" | "file" | "reminder"));
  if (folderId !== undefined && folderId !== null) conditions.push(eq(itemsTable.folderId, folderId));
  if (status) conditions.push(eq(itemsTable.status, status as "active" | "archived" | "completed"));

  const items = await db.select().from(itemsTable)
    .where(and(...conditions))
    .orderBy(desc(itemsTable.createdAt))
    .limit(limit)
    .offset(offset);

  const result = await Promise.all(items.map(itemWithFolder));
  res.json(result);
});

// POST /items
router.post("/items", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateItemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  let reminderAt: Date | null = null;
  try {
    reminderAt = parseReminderDateTime(parsed.data.reminderAt);
  } catch {
    res.status(400).json({ error: "Некорректная дата напоминания" });
    return;
  }

  if (parsed.data.folderId !== undefined && parsed.data.folderId !== null) {
    const hasAccess = await folderBelongsToUser(req.auth!.userId, parsed.data.folderId);
    if (!hasAccess) {
      res.status(404).json({ error: "Папка не найдена" });
      return;
    }
  }

  const [item] = await db.insert(itemsTable).values({
    userId: req.auth!.userId,
    type: parsed.data.type as "note" | "file" | "reminder",
    title: parsed.data.title,
    content: parsed.data.content ?? null,
    folderId: parsed.data.folderId ?? null,
    reminderAt,
    status: "active",
    aiTags: [],
  }).returning();

  res.status(201).json(await itemWithFolder(item));
});

// GET /items/upload (must be before /:id)
router.post("/items/upload", requireAuth, async (req, res): Promise<void> => {
  const parsed = UploadFileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const { filename, mimeType, fileData, fileSize, folderId } = parsed.data;

  if (folderId !== undefined && folderId !== null) {
    const hasAccess = await folderBelongsToUser(req.auth!.userId, folderId);
    if (!hasAccess) {
      res.status(404).json({ error: "Папка не найдена" });
      return;
    }
  }

  const extraction = await extractTextFromUpload(filename, mimeType, fileData);

  const [item] = await db.insert(itemsTable).values({
    userId: req.auth!.userId,
    type: "file" as const,
    title: filename,
    content: extraction.text,
    summary: extraction.summary,
    originalFilename: filename,
    mimeType,
    fileData,
    fileSize,
    folderId: folderId ?? null,
    status: "active",
    aiTags: [],
  }).returning();

  res.status(201).json(await itemWithFolder(item));
});

// GET /items/:id
router.get("/items/:id", requireAuth, async (req, res): Promise<void> => {
  const params = GetItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const [item] = await db.select().from(itemsTable)
    .where(and(eq(itemsTable.id, params.data.id), eq(itemsTable.userId, req.auth!.userId)))
    .limit(1);

  if (!item) {
    res.status(404).json({ error: "Элемент не найден" });
    return;
  }

  res.json(await itemWithFolder(item));
});

// PATCH /items/:id
router.patch("/items/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const parsed = UpdateItemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const rawBody = req.body as Record<string, unknown>;
  const updates: Record<string, unknown> = {};
  const requestedType = rawBody.type;
  if (requestedType !== undefined) {
    if (requestedType !== "note" && requestedType !== "file" && requestedType !== "reminder") {
      res.status(400).json({ error: "РќРµРєРѕСЂСЂРµРєС‚РЅС‹Р№ С‚РёРї СЌР»РµРјРµРЅС‚Р°" });
      return;
    }
    updates.type = requestedType;
    if (requestedType === "note" && parsed.data.reminderAt === undefined) {
      updates.reminderAt = null;
    }
  }
  if (parsed.data.title !== undefined) updates.title = parsed.data.title;
  if (parsed.data.content !== undefined) updates.content = parsed.data.content;
  if (parsed.data.folderId !== undefined) updates.folderId = parsed.data.folderId;
  if (parsed.data.reminderAt !== undefined) {
    try {
      updates.reminderAt = parseReminderDateTime(parsed.data.reminderAt);
    } catch {
      res.status(400).json({ error: "Некорректная дата напоминания" });
      return;
    }
  }
  if (parsed.data.status !== undefined) updates.status = parsed.data.status;

  if (parsed.data.folderId !== undefined && parsed.data.folderId !== null) {
    const hasAccess = await folderBelongsToUser(req.auth!.userId, parsed.data.folderId);
    if (!hasAccess) {
      res.status(404).json({ error: "Папка не найдена" });
      return;
    }
  }

  const [item] = await db.update(itemsTable)
    .set(updates)
    .where(and(eq(itemsTable.id, params.data.id), eq(itemsTable.userId, req.auth!.userId)))
    .returning();

  if (!item) {
    res.status(404).json({ error: "Элемент не найден" });
    return;
  }

  res.json(await itemWithFolder(item));
});

// DELETE /items/:id
router.delete("/items/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const [item] = await db.delete(itemsTable)
    .where(and(eq(itemsTable.id, params.data.id), eq(itemsTable.userId, req.auth!.userId)))
    .returning();

  if (!item) {
    res.status(404).json({ error: "Элемент не найден" });
    return;
  }

  res.sendStatus(204);
});

// GET /search
router.get("/search", requireAuth, async (req, res): Promise<void> => {
  const params = SearchItemsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const { q, type, folderId } = params.data;
  const userId = req.auth!.userId;

  if (folderId !== undefined && folderId !== null) {
    const hasAccess = await folderBelongsToUser(userId, folderId);
    if (!hasAccess) {
      res.status(404).json({ error: "Папка не найдена" });
      return;
    }
  }

  const conditions = [
    eq(itemsTable.userId, userId),
    or(
      ilike(itemsTable.title, `%${q}%`),
      ilike(sql`coalesce(${itemsTable.content}, '')`, `%${q}%`),
      ilike(sql`coalesce(${itemsTable.summary}, '')`, `%${q}%`),
      ilike(sql`coalesce(${itemsTable.originalFilename}, '')`, `%${q}%`)
    )!,
  ];

  if (type) conditions.push(eq(itemsTable.type, type as "note" | "file" | "reminder"));
  if (folderId !== undefined && folderId !== null) conditions.push(eq(itemsTable.folderId, folderId));

  const items = await db.select().from(itemsTable)
    .where(and(...conditions))
    .orderBy(desc(itemsTable.updatedAt))
    .limit(50);

  const result = await Promise.all(items.map(itemWithFolder));
  res.json(result);
});

// GET /stats/workspace
router.get("/stats/workspace", requireAuth, async (req, res): Promise<void> => {
  const userId = req.auth!.userId;

  const [totalItems] = await db.select({ count: sql<number>`count(*)::int` }).from(itemsTable).where(eq(itemsTable.userId, userId));
  const [totalNotes] = await db.select({ count: sql<number>`count(*)::int` }).from(itemsTable).where(and(eq(itemsTable.userId, userId), eq(itemsTable.type, "note")));
  const [totalFiles] = await db.select({ count: sql<number>`count(*)::int` }).from(itemsTable).where(and(eq(itemsTable.userId, userId), eq(itemsTable.type, "file")));
  const [totalReminders] = await db.select({ count: sql<number>`count(*)::int` }).from(itemsTable).where(and(eq(itemsTable.userId, userId), eq(itemsTable.type, "reminder")));
  const [totalFolders] = await db.select({ count: sql<number>`count(*)::int` }).from(foldersTable).where(eq(foldersTable.userId, userId));
  const [pendingReminders] = await db.select({ count: sql<number>`count(*)::int` }).from(itemsTable).where(and(eq(itemsTable.userId, userId), eq(itemsTable.type, "reminder"), eq(itemsTable.status, "active")));

  // Conversations count
  const { conversations } = await import("@workspace/db");
  const [totalConversations] = await db.select({ count: sql<number>`count(*)::int` }).from(conversations).where(eq(conversations.userId, userId));

  res.json({
    totalItems: totalItems?.count ?? 0,
    totalNotes: totalNotes?.count ?? 0,
    totalFiles: totalFiles?.count ?? 0,
    totalReminders: totalReminders?.count ?? 0,
    totalFolders: totalFolders?.count ?? 0,
    pendingReminders: pendingReminders?.count ?? 0,
    totalConversations: totalConversations?.count ?? 0,
  });
});

// GET /stats/recent
router.get("/stats/recent", requireAuth, async (req, res): Promise<void> => {
  const params = GetRecentItemsQueryParams.safeParse(req.query);
  const limit = params.success ? (params.data.limit ?? 10) : 10;

  const items = await db.select().from(itemsTable)
    .where(eq(itemsTable.userId, req.auth!.userId))
    .orderBy(desc(itemsTable.updatedAt))
    .limit(limit);

  const result = await Promise.all(items.map(itemWithFolder));
  res.json(result);
});

// GET /stats/reminders/upcoming
router.get("/stats/reminders/upcoming", requireAuth, async (req, res): Promise<void> => {
  const params = GetUpcomingRemindersQueryParams.safeParse(req.query);
  const limit = params.success ? (params.data.limit ?? 5) : 5;

  const now = new Date();

  const items = await db.select().from(itemsTable)
    .where(and(
      eq(itemsTable.userId, req.auth!.userId),
      eq(itemsTable.type, "reminder"),
      eq(itemsTable.status, "active"),
      sql`${itemsTable.reminderAt} > ${now}`
    ))
    .orderBy(asc(itemsTable.reminderAt))
    .limit(limit);

  const result = await Promise.all(items.map(itemWithFolder));
  res.json(result);
});

export default router;
