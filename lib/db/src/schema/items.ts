import { pgTable, text, serial, timestamp, integer, real, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { foldersTable } from "./folders";

export const itemTypeEnum = pgEnum("item_type", ["note", "file", "reminder"]);
export const itemStatusEnum = pgEnum("item_status", ["active", "archived", "completed"]);

export const itemsTable = pgTable("items", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  folderId: integer("folder_id").references(() => foldersTable.id, { onDelete: "set null" }),
  type: itemTypeEnum("type").notNull(),
  title: text("title").notNull(),
  content: text("content"),
  summary: text("summary"),
  originalFilename: text("original_filename"),
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),
  fileData: text("file_data"), // base64-encoded file content
  reminderAt: timestamp("reminder_at", { withTimezone: true }),
  status: itemStatusEnum("status").notNull().default("active"),
  aiCategory: text("ai_category"),
  aiTags: jsonb("ai_tags").$type<string[]>().notNull().default([]),
  aiConfidence: real("ai_confidence"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertItemSchema = createInsertSchema(itemsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertItem = z.infer<typeof insertItemSchema>;
export type Item = typeof itemsTable.$inferSelect;
