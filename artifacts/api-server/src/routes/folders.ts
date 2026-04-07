import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, foldersTable, itemsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import {
  CreateFolderBody,
  GetFolderParams,
  UpdateFolderParams,
  UpdateFolderBody,
  DeleteFolderParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

// Helper to add item count to folder
async function getFolderWithCount(folder: typeof foldersTable.$inferSelect) {
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(itemsTable)
    .where(and(eq(itemsTable.folderId, folder.id), eq(itemsTable.status, "active")));

  return {
    id: folder.id,
    userId: folder.userId,
    name: folder.name,
    color: folder.color ?? null,
    icon: folder.icon ?? null,
    isSystem: folder.isSystem,
    itemCount: countRow?.count ?? 0,
    createdAt: folder.createdAt.toISOString(),
    updatedAt: folder.updatedAt.toISOString(),
  };
}

// GET /folders
router.get("/folders", requireAuth, async (req, res): Promise<void> => {
  const folders = await db.select().from(foldersTable)
    .where(eq(foldersTable.userId, req.auth!.userId))
    .orderBy(foldersTable.createdAt);

  const foldersWithCounts = await Promise.all(folders.map(getFolderWithCount));
  res.json(foldersWithCounts);
});

// POST /folders
router.post("/folders", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateFolderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [folder] = await db.insert(foldersTable).values({
    userId: req.auth!.userId,
    name: parsed.data.name,
    color: parsed.data.color ?? null,
    icon: parsed.data.icon ?? null,
    isSystem: false,
  }).returning();

  res.status(201).json(await getFolderWithCount(folder));
});

// GET /folders/:id
router.get("/folders/:id", requireAuth, async (req, res): Promise<void> => {
  const params = GetFolderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [folder] = await db.select().from(foldersTable)
    .where(and(eq(foldersTable.id, params.data.id), eq(foldersTable.userId, req.auth!.userId)))
    .limit(1);

  if (!folder) {
    res.status(404).json({ error: "Folder not found" });
    return;
  }

  res.json(await getFolderWithCount(folder));
});

// PATCH /folders/:id
router.patch("/folders/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateFolderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateFolderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Partial<typeof foldersTable.$inferInsert> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.color !== undefined) updates.color = parsed.data.color ?? null;
  if (parsed.data.icon !== undefined) updates.icon = parsed.data.icon ?? null;

  const [folder] = await db.update(foldersTable)
    .set(updates)
    .where(and(eq(foldersTable.id, params.data.id), eq(foldersTable.userId, req.auth!.userId)))
    .returning();

  if (!folder) {
    res.status(404).json({ error: "Folder not found" });
    return;
  }

  res.json(await getFolderWithCount(folder));
});

// DELETE /folders/:id
router.delete("/folders/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteFolderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Prevent deleting system folders
  const [folder] = await db.select().from(foldersTable)
    .where(and(eq(foldersTable.id, params.data.id), eq(foldersTable.userId, req.auth!.userId)))
    .limit(1);

  if (!folder) {
    res.status(404).json({ error: "Folder not found" });
    return;
  }

  if (folder.isSystem) {
    res.status(400).json({ error: "Cannot delete system folders" });
    return;
  }

  await db.delete(foldersTable)
    .where(and(eq(foldersTable.id, params.data.id), eq(foldersTable.userId, req.auth!.userId)));

  res.sendStatus(204);
});

export default router;
