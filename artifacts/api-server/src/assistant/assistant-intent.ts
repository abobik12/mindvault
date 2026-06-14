import { z } from "zod/v4";

const baseIntentSchema = {
  confidence: z.number().min(0).max(1),
  needsConfirmation: z.boolean(),
};

const folderNameSchema = z.string().trim().min(1).max(120).nullable().optional();
const itemTypeSchema = z.enum(["note", "list", "reminder", "file", "folder"]);

export const assistantIntentSchema = z.discriminatedUnion("intent", [
  z
    .object({
      intent: z.literal("create_note"),
      ...baseIntentSchema,
      data: z
        .object({
          title: z.string().trim().min(1).max(200),
          content: z.string().trim().min(1).max(20_000),
          folderName: folderNameSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      intent: z.literal("create_list"),
      ...baseIntentSchema,
      data: z
        .object({
          title: z.string().trim().min(1).max(200),
          items: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
          folderName: folderNameSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      intent: z.literal("create_reminder"),
      ...baseIntentSchema,
      data: z
        .object({
          title: z.string().trim().min(1).max(200),
          content: z.string().trim().max(2_000).optional().default(""),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          time: z
            .string()
            .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
            .optional()
            .default("09:00"),
          folderName: folderNameSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      intent: z.literal("search_items"),
      ...baseIntentSchema,
      data: z
        .object({
          query: z.string().trim().min(1).max(500),
          types: z.array(itemTypeSchema).min(1).max(5).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      intent: z.literal("move_item_to_folder"),
      ...baseIntentSchema,
      data: z
        .object({
          itemQuery: z.string().trim().min(1).max(500),
          itemType: itemTypeSchema.exclude(["folder"]).optional(),
          folderName: z.string().trim().min(1).max(120),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      intent: z.literal("create_folder"),
      ...baseIntentSchema,
      data: z.object({ name: z.string().trim().min(1).max(120) }).strict(),
    })
    .strict(),
  z
    .object({
      intent: z.literal("rename_folder"),
      ...baseIntentSchema,
      data: z
        .object({
          folderName: z.string().trim().min(1).max(120),
          newName: z.string().trim().min(1).max(120),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      intent: z.literal("delete_item"),
      ...baseIntentSchema,
      data: z
        .object({
          itemQuery: z.string().trim().min(1).max(500),
          itemType: itemTypeSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      intent: z.literal("chat_general"),
      ...baseIntentSchema,
      data: z.object({}).strict().optional(),
    })
    .strict(),
  z
    .object({
      intent: z.literal("clarify"),
      ...baseIntentSchema,
      data: z
        .object({
          question: z.string().trim().min(1).max(1_000),
        })
        .strict(),
    })
    .strict(),
]);

export type AssistantIntent = z.infer<typeof assistantIntentSchema>;

