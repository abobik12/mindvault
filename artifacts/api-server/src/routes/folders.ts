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

router.get("/folders", requireAuth, async (req, res): Promise<void> => {
  const folders = await db
    .select()
    .from(foldersTable)
    .where(eq(foldersTable.userId, req.auth!.userId))
    .orderBy(foldersTable.createdAt);

  const foldersWithCounts = await Promise.all(folders.map(getFolderWithCount));
  res.json(foldersWithCounts);
});

router.post("/folders", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateFolderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const [folder] = await db
    .insert(foldersTable)
    .values({
      userId: req.auth!.userId,
      name: parsed.data.name,
      color: parsed.data.color ?? null,
      icon: parsed.data.icon ?? null,
      isSystem: false,
    })
    .returning();

  res.status(201).json(await getFolderWithCount(folder));
});

router.get("/folders/:id", requireAuth, async (req, res): Promise<void> => {
  const params = GetFolderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const [folder] = await db
    .select()
    .from(foldersTable)
    .where(and(eq(foldersTable.id, params.data.id), eq(foldersTable.userId, req.auth!.userId)))
    .limit(1);

  if (!folder) {
    res.status(404).json({ error: "Папка не найдена" });
    return;
  }

  res.json(await getFolderWithCount(folder));
});

router.patch("/folders/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateFolderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const parsed = UpdateFolderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const [existingFolder] = await db
    .select()
    .from(foldersTable)
    .where(and(eq(foldersTable.id, params.data.id), eq(foldersTable.userId, req.auth!.userId)))
    .limit(1);

  if (!existingFolder) {
    res.status(404).json({ error: "Папка не найдена" });
    return;
  }

  if (existingFolder.isSystem) {
    res.status(400).json({ error: "Системные папки нельзя изменять" });
    return;
  }

  const updates: Partial<typeof foldersTable.$inferInsert> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.color !== undefined) updates.color = parsed.data.color ?? null;
  if (parsed.data.icon !== undefined) updates.icon = parsed.data.icon ?? null;

  const [folder] = await db
    .update(foldersTable)
    .set(updates)
    .where(and(eq(foldersTable.id, params.data.id), eq(foldersTable.userId, req.auth!.userId)))
    .returning();

  if (!folder) {
    res.status(404).json({ error: "Папка не найдена" });
    return;
  }

  res.json(await getFolderWithCount(folder));
});

router.delete("/folders/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteFolderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const [folder] = await db
    .select()
    .from(foldersTable)
    .where(and(eq(foldersTable.id, params.data.id), eq(foldersTable.userId, req.auth!.userId)))
    .limit(1);

  if (!folder) {
    res.status(404).json({ error: "Папка не найдена" });
    return;
  }

  if (folder.isSystem) {
    res.status(400).json({ error: "Системные папки удалять нельзя" });
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(itemsTable)
      .set({ folderId: null })
      .where(and(eq(itemsTable.folderId, params.data.id), eq(itemsTable.userId, req.auth!.userId)));

    await tx
      .delete(foldersTable)
      .where(and(eq(foldersTable.id, params.data.id), eq(foldersTable.userId, req.auth!.userId)));
  });

  res.sendStatus(204);
});

export default router;
