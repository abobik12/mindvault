import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  assistantOperations,
  db,
  foldersTable,
  itemsTable,
  type AssistantOperationChange,
} from "@workspace/db";
import type { AssistantActionResponse } from "./actions";

type Snapshot = {
  items: Record<string, unknown>[];
  folders: Record<string, unknown>[];
};

function serializeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        serializeValue(entry),
      ]),
    );
  }
  return value;
}

function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  return serializeValue(row) as Record<string, unknown>;
}

function rowsEqual(
  left: Record<string, unknown> | null,
  right: Record<string, unknown> | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function indexRows(rows: Record<string, unknown>[]) {
  return new Map(rows.map((row) => [Number(row.id), row]));
}

export function diffAssistantSnapshots(
  before: Snapshot,
  after: Snapshot,
): AssistantOperationChange[] {
  const changes: AssistantOperationChange[] = [];

  for (const entity of ["folder", "item"] as const) {
    const beforeRows = indexRows(entity === "item" ? before.items : before.folders);
    const afterRows = indexRows(entity === "item" ? after.items : after.folders);
    const ids = new Set([...beforeRows.keys(), ...afterRows.keys()]);
    for (const id of ids) {
      const previous = beforeRows.get(id) ?? null;
      const next = afterRows.get(id) ?? null;
      if (rowsEqual(previous, next)) continue;
      changes.push({
        entity,
        kind: previous ? (next ? "update" : "delete") : "create",
        before: previous,
        after: next,
      });
    }
  }

  return changes;
}

export async function captureAssistantSnapshot(userId: number): Promise<Snapshot> {
  const [items, folders] = await Promise.all([
    db.select().from(itemsTable).where(eq(itemsTable.userId, userId)),
    db.select().from(foldersTable).where(eq(foldersTable.userId, userId)),
  ]);
  return {
    items: items.map((item) => serializeRow(item as unknown as Record<string, unknown>)),
    folders: folders.map((folder) =>
      serializeRow(folder as unknown as Record<string, unknown>),
    ),
  };
}

export function responseCanBeUndone(response: AssistantActionResponse): boolean {
  const result = response.assistantContext.actionResult;
  if (!result?.success) return false;
  return (
    result.action.startsWith("create_") ||
    result.action.startsWith("update_") ||
    result.action.startsWith("delete_") ||
    result.action === "move_item_to_folder" ||
    result.action === "rename_folder"
  );
}

export async function attachUndoOperation({
  userId,
  conversationId,
  before,
  response,
}: {
  userId: number;
  conversationId: number;
  before: Snapshot;
  response: AssistantActionResponse;
}): Promise<AssistantActionResponse> {
  if (!responseCanBeUndone(response)) return response;
  const after = await captureAssistantSnapshot(userId);
  const changes = diffAssistantSnapshots(before, after);
  if (changes.length === 0) return response;

  const id = randomUUID();
  await db.insert(assistantOperations).values({
    id,
    userId,
    conversationId,
    operationType:
      response.assistantContext.actionResult?.action ?? response.intentType,
    changes,
    status: "ready",
  });

  return {
    ...response,
    assistantContext: {
      ...response.assistantContext,
      undoAction: { id, label: "Отменить" },
    },
  };
}

function deserializeItem(row: Record<string, unknown>) {
  return {
    ...row,
    reminderAt:
      typeof row.reminderAt === "string" ? new Date(row.reminderAt) : null,
    createdAt: new Date(String(row.createdAt)),
    updatedAt: new Date(String(row.updatedAt)),
  } as typeof itemsTable.$inferInsert & { id: number };
}

function deserializeFolder(row: Record<string, unknown>) {
  return {
    ...row,
    createdAt: new Date(String(row.createdAt)),
    updatedAt: new Date(String(row.updatedAt)),
  } as typeof foldersTable.$inferInsert & { id: number };
}

async function getCurrentRow(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: number,
  change: AssistantOperationChange,
) {
  const id = Number((change.after ?? change.before)?.id);
  if (change.entity === "item") {
    const [row] = await tx
      .select()
      .from(itemsTable)
      .where(and(eq(itemsTable.id, id), eq(itemsTable.userId, userId)))
      .limit(1);
    return row ? serializeRow(row as unknown as Record<string, unknown>) : null;
  }
  const [row] = await tx
    .select()
    .from(foldersTable)
    .where(and(eq(foldersTable.id, id), eq(foldersTable.userId, userId)))
    .limit(1);
  return row ? serializeRow(row as unknown as Record<string, unknown>) : null;
}

export async function undoAssistantOperation({
  operationId,
  userId,
  conversationId,
}: {
  operationId: string;
  userId: number;
  conversationId: number;
}): Promise<{ success: boolean; message: string }> {
  return db.transaction(async (tx) => {
    const [operation] = await tx
      .update(assistantOperations)
      .set({ status: "undoing" })
      .where(
        and(
          eq(assistantOperations.id, operationId),
          eq(assistantOperations.userId, userId),
          eq(assistantOperations.conversationId, conversationId),
          eq(assistantOperations.status, "ready"),
        ),
      )
      .returning();

    if (!operation) {
      return {
        success: false,
        message: "Это действие уже отменено или больше недоступно.",
      };
    }

    for (const change of operation.changes) {
      const current = await getCurrentRow(tx, userId, change);
      if (!rowsEqual(current, change.after)) {
        throw new Error("undo_conflict");
      }
    }

    const folderRestores = operation.changes.filter(
      (change) => change.entity === "folder" && change.kind === "delete",
    );
    for (const change of folderRestores) {
      await tx.insert(foldersTable).values(deserializeFolder(change.before!));
    }

    const itemRestores = operation.changes.filter(
      (change) => change.entity === "item" && change.kind === "delete",
    );
    for (const change of itemRestores) {
      await tx.insert(itemsTable).values(deserializeItem(change.before!));
    }

    for (const change of operation.changes.filter(
      (entry) => entry.kind === "update",
    )) {
      const id = Number(change.before!.id);
      if (change.entity === "item") {
        const previous = deserializeItem(change.before!);
        await tx
          .update(itemsTable)
          .set(previous)
          .where(and(eq(itemsTable.id, id), eq(itemsTable.userId, userId)));
      } else {
        const previous = deserializeFolder(change.before!);
        await tx
          .update(foldersTable)
          .set(previous)
          .where(and(eq(foldersTable.id, id), eq(foldersTable.userId, userId)));
      }
    }

    for (const change of operation.changes.filter(
      (entry) => entry.entity === "item" && entry.kind === "create",
    )) {
      await tx
        .delete(itemsTable)
        .where(
          and(
            eq(itemsTable.id, Number(change.after!.id)),
            eq(itemsTable.userId, userId),
          ),
        );
    }
    for (const change of operation.changes.filter(
      (entry) => entry.entity === "folder" && entry.kind === "create",
    )) {
      await tx
        .delete(foldersTable)
        .where(
          and(
            eq(foldersTable.id, Number(change.after!.id)),
            eq(foldersTable.userId, userId),
          ),
        );
    }

    await tx
      .update(assistantOperations)
      .set({ status: "undone", undoneAt: new Date() })
      .where(eq(assistantOperations.id, operation.id));

    return { success: true, message: "Действие отменено." };
  }).catch((error) => {
    if (error instanceof Error && error.message === "undo_conflict") {
      return {
        success: false,
        message:
          "После этого действия данные уже изменились, поэтому отменить его безопасно нельзя.",
      };
    }
    throw error;
  });
}
