import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { conversations } from "./conversations";

export type AssistantOperationChange = {
  entity: "item" | "folder";
  kind: "create" | "update" | "delete";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

export const assistantOperations = pgTable("assistant_operations", {
  id: text("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  operationType: text("operation_type").notNull(),
  changes: jsonb("changes").$type<AssistantOperationChange[]>().notNull(),
  status: text("status").notNull().default("ready"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
});

export type AssistantOperation = typeof assistantOperations.$inferSelect;
