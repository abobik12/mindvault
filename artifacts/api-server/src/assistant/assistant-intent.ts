import { z } from "zod/v4";

const memoryUpdateSchema = z
  .object({
    category: z.enum([
      "person",
      "alias",
      "slang",
      "preference",
      "project",
      "habit",
    ]),
    key: z.string().trim().min(1).max(120),
    value: z.string().trim().min(1).max(500),
  })
  .strict();

const baseIntentSchema = {
  memory: z
    .object({
      facts: z.array(memoryUpdateSchema).max(5),
    })
    .strict()
    .optional(),
};

const folderNameSchema = z.string().trim().min(1).max(120).nullable().optional();
const itemTypeSchema = z.enum(["note", "list", "reminder", "file", "folder"]);
const mutableItemTypeSchema = itemTypeSchema.exclude(["folder"]);
const targetQuerySchema = z.string().trim().min(1).max(500);

export const assistantIntentSchema = z.discriminatedUnion("intent", [
  z
    .object({
      intent: z.literal("create_note"),
      ...baseIntentSchema,
      data: z
        .object({
          title: z.string().trim().min(1).max(200),
          content: z.string().trim().max(20_000),
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
      intent: z.literal("answer_from_sources"),
      ...baseIntentSchema,
      data: z
        .object({
          query: z.string().trim().min(1).max(1_000),
          types: z.array(itemTypeSchema).min(1).max(5).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      intent: z.literal("update_note"),
      ...baseIntentSchema,
      data: z
        .object({
          targetQuery: targetQuerySchema,
          title: z.string().trim().min(1).max(200).optional(),
          content: z.string().trim().min(1).max(20_000).optional(),
        })
        .strict()
        .refine((data) => data.title !== undefined || data.content !== undefined, {
          message: "At least one note update field is required",
        }),
    })
    .strict(),
  z
    .object({
      intent: z.literal("update_list"),
      ...baseIntentSchema,
      data: z
        .object({
          targetQuery: targetQuerySchema,
          title: z.string().trim().min(1).max(200).optional(),
          addItems: z.array(z.string().trim().min(1).max(500)).min(1).max(100).optional(),
          removeItems: z.array(z.string().trim().min(1).max(500)).min(1).max(100).optional(),
          completeItems: z.array(z.string().trim().min(1).max(500)).min(1).max(100).optional(),
          reopenItems: z.array(z.string().trim().min(1).max(500)).min(1).max(100).optional(),
        })
        .strict()
        .refine(
          (data) =>
            data.title !== undefined ||
            data.addItems !== undefined ||
            data.removeItems !== undefined ||
            data.completeItems !== undefined ||
            data.reopenItems !== undefined,
          { message: "At least one list update field is required" },
        ),
    })
    .strict(),
  z
    .object({
      intent: z.literal("update_reminder"),
      ...baseIntentSchema,
      data: z
        .object({
          targetQuery: targetQuerySchema,
          title: z.string().trim().min(1).max(200).optional(),
          content: z.string().trim().min(1).max(2_000).optional(),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
        })
        .strict()
        .refine(
          (data) =>
            data.title !== undefined ||
            data.content !== undefined ||
            data.date !== undefined ||
            data.time !== undefined,
          { message: "At least one reminder update field is required" },
        ),
    })
    .strict(),
  z
    .object({
      intent: z.literal("move_item_to_folder"),
      ...baseIntentSchema,
      data: z
        .object({
          itemQuery: z.string().trim().min(1).max(500),
          itemType: mutableItemTypeSchema.optional(),
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
      intent: z.literal("cancel"),
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

