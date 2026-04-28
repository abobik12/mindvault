import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, conversations, messages, itemsTable, foldersTable } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { ai } from "@workspace/integrations-gemini-ai";
import {
  CreateGeminiConversationBody,
  SendGeminiMessageBody,
  GetGeminiConversationParams,
  DeleteGeminiConversationParams,
  ListGeminiMessagesParams,
  SendGeminiMessageParams,
  ClassifyContentBody,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import {
  formatMoscowDateTime,
  getCurrentMoscowDateTimeForModel,
  parseReminderDateTime,
} from "../lib/time";

const router: IRouter = Router();
const OPENAI_TEXT_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const DEFAULT_ASSISTANT_SYSTEM_PROMPT = `Ты — ассистент MindVault, персонального рабочего кабинета пользователя.

Твоя задача:
- отвечать дружелюбно и по делу;
- помогать структурировать мысли, заметки и напоминания;
- использовать ясные формулировки на русском языке;
- не добавлять лишнюю воду.

Если пользователь что-то сохранил, подтверждай это естественно и кратко.`;

const FUTURE_TIME_SIGNAL_RE =
  /(завтра|послезавтра|через\s+\d+\s*(минут|час|дн|день|дня|дней|недел|месяц|месяца|месяцев)|в\s+(понедельник|вторник|среду|среда|четверг|пятницу|пятница|субботу|суббота|воскресенье)|в\s?\d{1,2}[:.]\d{2}|к\s?\d{1,2}[:.]\d{2}|утром|днем|вечером|ночью)/i;
const FUTURE_ACTION_SIGNAL_RE =
  /(напомни|напомнить|нужно|надо|не\s?забыть|нужно\s+будет|надо\s+будет|буд[уе]т|поздравить|купить|сделать|подготовить|отправить|созвон|встреча)/i;
const EXPLICIT_SAVE_NOTE_RE =
  /(сохрани|сохранить|запиши|записать|добавь\s+заметк|создай\s+заметк|сделай\s+заметк)/i;
const EXPLICIT_SAVE_REMINDER_RE =
  /(напомни|создай\s+напомин|добавь\s+напомин|поставь\s+напомин|установи\s+напомин)/i;
const ACTION_ON_EXISTING_RE =
  /(перемест|перенес|перенеси|переимену|удали|исправь|измени|обнови|отредактируй)/i;
const AMBIGUOUS_REMINDER_RE =
  /(завтра|послезавтра|в\s+(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)|через\s+\d+)/i;

type IntentType = "chat_only" | "save_note" | "save_reminder" | "save_file" | "action_on_existing";
type ResponseMode = "reply_only" | "saved" | "suggest_actions" | "action_executed";

type AssistantContext = {
  intentType: IntentType;
  responseMode: ResponseMode;
  autoSaved?: boolean;
  assistantReply?: string;
  savedItem?: {
    id: number;
    type: "note" | "file" | "reminder";
    title: string;
    folderId: number | null;
    folderName: string | null;
    reminderAt?: string | null;
  } | null;
  suggestedActions?: Array<"save_note" | "save_reminder" | "ignore">;
} | null;

function looksLikeFutureReminderIntent(content: string): boolean {
  const normalized = content.toLowerCase();
  const hasTimeSignal = FUTURE_TIME_SIGNAL_RE.test(normalized);
  const hasActionSignal = FUTURE_ACTION_SIGNAL_RE.test(normalized);
  return hasTimeSignal && hasActionSignal;
}

function sanitizeAssistantContext(raw: unknown): AssistantContext {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;

  const intentType = source.intentType;
  const responseMode = source.responseMode;
  if (
    intentType !== "chat_only" &&
    intentType !== "save_note" &&
    intentType !== "save_reminder" &&
    intentType !== "save_file" &&
    intentType !== "action_on_existing"
  ) {
    return null;
  }
  if (
    responseMode !== "reply_only" &&
    responseMode !== "saved" &&
    responseMode !== "suggest_actions" &&
    responseMode !== "action_executed"
  ) {
    return null;
  }

  let savedItem: AssistantContext["savedItem"] = null;
  const rawSavedItem = source.savedItem;
  if (rawSavedItem && typeof rawSavedItem === "object") {
    const item = rawSavedItem as Record<string, unknown>;
    const rawType = item.type;
    const rawId = item.id;
    const rawTitle = item.title;
    if (
      (rawType === "note" || rawType === "file" || rawType === "reminder") &&
      typeof rawId === "number" &&
      typeof rawTitle === "string"
    ) {
      savedItem = {
        id: rawId,
        type: rawType,
        title: rawTitle.slice(0, 180),
        folderId: typeof item.folderId === "number" ? item.folderId : null,
        folderName: typeof item.folderName === "string" ? item.folderName.slice(0, 120) : null,
        reminderAt: typeof item.reminderAt === "string" ? item.reminderAt : null,
      };
    }
  }

  const rawSuggested = source.suggestedActions;
  const suggestedActions = Array.isArray(rawSuggested)
    ? rawSuggested.filter(
        (entry): entry is "save_note" | "save_reminder" | "ignore" =>
          entry === "save_note" || entry === "save_reminder" || entry === "ignore",
      )
    : undefined;

  return {
    intentType,
    responseMode,
    autoSaved: source.autoSaved === true,
    assistantReply:
      typeof source.assistantReply === "string" && source.assistantReply.trim()
        ? source.assistantReply.trim().slice(0, 3000)
        : undefined,
    savedItem,
    suggestedActions: suggestedActions && suggestedActions.length > 0 ? suggestedActions : undefined,
  };
}

function extractFolderMention(content: string, folders: Array<{ id: number; name: string }>) {
  const lower = content.toLowerCase();
  return folders.find((folder) => lower.includes(folder.name.toLowerCase())) ?? null;
}

function detectItemTypeMention(content: string): "note" | "file" | "reminder" | null {
  const lower = content.toLowerCase();
  if (lower.includes("файл")) return "file";
  if (lower.includes("напомин")) return "reminder";
  if (lower.includes("заметк")) return "note";
  return null;
}

async function tryHandleMoveLatestAction({
  content,
  userId,
  folders,
}: {
  content: string;
  userId: number;
  folders: Array<{ id: number; name: string }>;
}) {
  const lower = content.toLowerCase();
  const asksMove = /(перемест|перенес|перенеси|перемести)/i.test(lower);
  if (!asksMove) return null;

  const targetFolder = extractFolderMention(content, folders);
  if (!targetFolder) return null;

  const mentionedType = detectItemTypeMention(content);
  const isAboutLast = /(последн|последнюю|последний|последнее|мою|мой|мое)/i.test(lower);
  if (!isAboutLast) return null;

  const baseConditions = [eq(itemsTable.userId, userId), eq(itemsTable.status, "active")];
  if (mentionedType) {
    baseConditions.push(eq(itemsTable.type, mentionedType));
  }

  const [latestItem] = await db
    .select()
    .from(itemsTable)
    .where(and(...baseConditions))
    .orderBy(desc(itemsTable.updatedAt))
    .limit(1);

  if (!latestItem) return null;

  const [updatedItem] = await db
    .update(itemsTable)
    .set({ folderId: targetFolder.id })
    .where(and(eq(itemsTable.id, latestItem.id), eq(itemsTable.userId, userId)))
    .returning();

  if (!updatedItem) return null;

  return {
    item: updatedItem,
    folder: targetFolder,
  };
}

function buildOfflineAssistantReply(userMessage: string, reason?: string): string {
  const trimmed = userMessage.trim();
  const isQuotaError =
    typeof reason === "string" &&
    (reason.includes("insufficient_quota") || reason.toLowerCase().includes("quota"));

  if (isQuotaError) {
    return [
      "Сейчас AI-провайдер недоступен из-за лимита аккаунта (`insufficient_quota`).",
      "",
      "Что сделать:",
      "- пополнить баланс/включить биллинг у провайдера;",
      "- или указать другой ключ/провайдер в `OPENROUTER_API_KEY` / `OPENAI_API_KEY`.",
      "",
      `Ваш запрос: **${trimmed || "пустой запрос"}**`,
    ].join("\n");
  }

  if (!trimmed) {
    return "Я на связи в офлайн-режиме. Напишите сообщение, и я помогу сформулировать задачу.";
  }

  return [
    "Сейчас не удалось получить ответ от AI-провайдера, поэтому включен офлайн-режим.",
    "",
    `Ваш запрос: **${trimmed}**`,
    "",
    "Что можно сделать прямо сейчас:",
    "- я могу помочь структурировать задачу;",
    "- подготовить текст заметки;",
    "- предложить формулировку напоминания в московском времени.",
  ].join("\n");
}

router.get("/gemini/conversations", requireAuth, async (req, res): Promise<void> => {
  const convs = await db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, req.auth!.userId))
    .orderBy(conversations.createdAt);

  res.json(
    convs.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt.toISOString(),
    })),
  );
});

router.post("/gemini/conversations", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateGeminiConversationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const [conversation] = await db
    .insert(conversations)
    .values({
      userId: req.auth!.userId,
      title: parsed.data.title,
    })
    .returning();

  res.status(201).json({
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt.toISOString(),
  });
});

router.get("/gemini/conversations/:id", requireAuth, async (req, res): Promise<void> => {
  const params = GetGeminiConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, params.data.id), eq(conversations.userId, req.auth!.userId)))
    .limit(1);

  if (!conversation) {
    res.status(404).json({ error: "Диалог не найден" });
    return;
  }

  const conversationMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(messages.createdAt);

  res.json({
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt.toISOString(),
    messages: conversationMessages.map((message) => ({
      id: message.id,
      conversationId: message.conversationId,
      role: message.role,
      content: message.content,
      metadata: message.metadata ?? null,
      createdAt: message.createdAt.toISOString(),
    })),
  });
});

router.delete("/gemini/conversations/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteGeminiConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const [deleted] = await db
    .delete(conversations)
    .where(and(eq(conversations.id, params.data.id), eq(conversations.userId, req.auth!.userId)))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Диалог не найден" });
    return;
  }

  res.sendStatus(204);
});

router.get("/gemini/conversations/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const params = ListGeminiMessagesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, params.data.id), eq(conversations.userId, req.auth!.userId)))
    .limit(1);

  if (!conversation) {
    res.status(404).json({ error: "Диалог не найден" });
    return;
  }

  const conversationMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(messages.createdAt);

  res.json(
    conversationMessages.map((message) => ({
      id: message.id,
      conversationId: message.conversationId,
      role: message.role,
      content: message.content,
      metadata: message.metadata ?? null,
      createdAt: message.createdAt.toISOString(),
    })),
  );
});

router.post("/gemini/conversations/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const params = SendGeminiMessageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const bodyParsed = SendGeminiMessageBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }
  const assistantContext = sanitizeAssistantContext((req.body as Record<string, unknown>)?.assistantContext);

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, params.data.id), eq(conversations.userId, req.auth!.userId)))
    .limit(1);

  if (!conversation) {
    res.status(404).json({ error: "Диалог не найден" });
    return;
  }

  await db
    .insert(messages)
    .values({
      conversationId: conversation.id,
      role: "user",
      content: bodyParsed.data.content,
      metadata: null,
    })
    .returning();

  const chatHistory = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(messages.createdAt);

  const systemPrompt =
    process.env.ASSISTANT_SYSTEM_PROMPT?.trim() || DEFAULT_ASSISTANT_SYSTEM_PROMPT;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  let fullResponse = "";
  const deterministicReply = assistantContext?.assistantReply?.trim();

  if (assistantContext && deterministicReply && assistantContext.responseMode !== "reply_only") {
    await db.insert(messages).values({
      conversationId: conversation.id,
      role: "assistant",
      content: deterministicReply,
      metadata: assistantContext,
    });

    res.write(`data: ${JSON.stringify({ content: deterministicReply })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    return;
  }

  try {
    const contentsForGemini = [
      { role: "user" as const, parts: [{ text: systemPrompt }] },
      {
        role: "model" as const,
        parts: [{ text: "Понял задачу. Готов помочь с организацией вашего рабочего пространства." }],
      },
      ...chatHistory.slice(0, -1).map((message) => ({
        role: (message.role === "assistant" ? "model" : "user") as "user" | "model",
        parts: [{ text: message.content }],
      })),
      { role: "user" as const, parts: [{ text: bodyParsed.data.content }] },
    ];

    const stream = await ai.models.generateContentStream({
      model: OPENAI_TEXT_MODEL,
      contents: contentsForGemini,
      config: { maxOutputTokens: 8192 },
    });

    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
      }
    }

    await db.insert(messages).values({
      conversationId: conversation.id,
      role: "assistant",
      content: fullResponse,
      metadata: assistantContext,
    });

    if (chatHistory.length <= 2) {
      const titlePrompt = `Сформируй короткий заголовок диалога (4-6 слов) по сообщению: \"${bodyParsed.data.content.slice(0, 100)}\". Ответь только заголовком, без кавычек.`;
      try {
        const titleResponse = await ai.models.generateContent({
          model: OPENAI_TEXT_MODEL,
          contents: [{ role: "user", parts: [{ text: titlePrompt }] }],
          config: { maxOutputTokens: 50 },
        });
        const newTitle = titleResponse.text?.trim();
        if (newTitle) {
          await db.update(conversations).set({ title: newTitle }).where(eq(conversations.id, conversation.id));
        }
      } catch (err) {
        logger.warn({ err }, "Не удалось автоматически создать заголовок диалога");
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (err) {
    logger.error({ err }, "Ошибка при стриминге ответа AI-провайдера, используем офлайн-ответ");

    const errorMessage =
      err instanceof Error ? err.message : typeof err === "string" ? err : undefined;
    const fallbackResponse = buildOfflineAssistantReply(bodyParsed.data.content, errorMessage);
    await db.insert(messages).values({
      conversationId: conversation.id,
      role: "assistant",
      content: fallbackResponse,
      metadata: assistantContext,
    });

    res.write(`data: ${JSON.stringify({ content: fallbackResponse })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  }

  res.end();
});

router.post("/gemini/classify", requireAuth, async (req, res): Promise<void> => {
  const parsed = ClassifyContentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Некорректные данные запроса" });
    return;
  }

  const { content, folderId: requestedFolderId } = parsed.data;
  const userId = req.auth!.userId;

  const userFolders = await db
    .select({ id: foldersTable.id, name: foldersTable.name })
    .from(foldersTable)
    .where(eq(foldersTable.userId, userId));

  let contextualFolderId: number | null = null;
  if (requestedFolderId !== undefined && requestedFolderId !== null) {
    const requestedFolder = userFolders.find((folder) => folder.id === requestedFolderId);
    if (!requestedFolder) {
      res.status(404).json({ error: "Папка не найдена" });
      return;
    }
    contextualFolderId = requestedFolder.id;
  }

  const folderNames = userFolders.map((folder) => folder.name).join(", ");

  const classifyPrompt = `Ты — интеллектуальный классификатор контента для персонального рабочего кабинета MindVault.

Проанализируй сообщение пользователя:
\"${content}\"

Доступные папки: ${folderNames || "Входящие, Заметки, Файлы, Напоминания"}
Контекст папки (если задан): ${contextualFolderId ? `ID ${contextualFolderId}` : "не задан"}
Текущая дата/время (Москва, UTC+3): ${getCurrentMoscowDateTimeForModel()}

Верни ТОЛЬКО валидный JSON в формате:
{
  "intentType": "chat_only" | "save_note" | "save_reminder" | "save_file" | "action_on_existing",
  "type": "note" | "reminder" | "file" | "chat",
  "title": "string или null",
  "summary": "string или null",
  "cleanedContent": "string или null",
  "suggestedFolder": "string или null",
  "tags": ["array", "of", "tags"],
  "confidence": число от 0 до 1,
  "reminderAt": "ISO дата-время или null",
  "shouldSave": true | false,
  "responseMode": "reply_only" | "saved" | "suggest_actions" | "action_executed"
}

Правила:
- chat_only: вопрос, уточнение, просьба объяснить, анализ текста, просьба помочь без явного сохранения;
- save_note: пользователь явно просит сохранить мысль/текст как заметку;
- save_reminder: пользователь явно просит создать напоминание;
- action_on_existing: пользователь просит изменить уже существующий объект (переместить, удалить, переименовать и т.д.);
- если намерение неоднозначно — выбирай chat_only и responseMode=suggest_actions.

Для reminder:
- если пользователь указывает время без часового пояса, трактуй его как московское время;
- возвращай reminderAt в ISO с часовым поясом +03:00.

shouldSave=true только при явном намерении save_note или save_reminder.`;

  let classification = {
    intentType: "chat_only" as IntentType,
    type: "chat" as "note" | "reminder" | "file" | "chat",
    title: null as string | null,
    summary: null as string | null,
    cleanedContent: null as string | null,
    suggestedFolder: null as string | null,
    tags: [] as string[],
    confidence: 0.5,
    reminderAt: null as string | null,
    shouldSave: false,
    responseMode: "reply_only" as ResponseMode,
  };

  try {
    const response = await ai.models.generateContent({
      model: OPENAI_TEXT_MODEL,
      contents: [{ role: "user", parts: [{ text: classifyPrompt }] }],
      config: {
        responseMimeType: "application/json",
        maxOutputTokens: 8192,
      },
    });

    const rawJson = response.text ?? "{}";
    const parsedJson = JSON.parse(rawJson);
    const parsedIntentType = parsedJson.intentType;
    const parsedResponseMode = parsedJson.responseMode;

    classification = {
      intentType:
        parsedIntentType === "save_note" ||
        parsedIntentType === "save_reminder" ||
        parsedIntentType === "save_file" ||
        parsedIntentType === "action_on_existing" ||
        parsedIntentType === "chat_only"
          ? parsedIntentType
          : "chat_only",
      type: ["note", "reminder", "file", "chat"].includes(parsedJson.type)
        ? parsedJson.type
        : "chat",
      title: typeof parsedJson.title === "string" ? parsedJson.title : null,
      summary: typeof parsedJson.summary === "string" ? parsedJson.summary : null,
      cleanedContent: typeof parsedJson.cleanedContent === "string" ? parsedJson.cleanedContent : null,
      suggestedFolder:
        typeof parsedJson.suggestedFolder === "string" ? parsedJson.suggestedFolder : null,
      tags: Array.isArray(parsedJson.tags)
        ? parsedJson.tags.filter((tag: unknown) => typeof tag === "string")
        : [],
      confidence: typeof parsedJson.confidence === "number" ? parsedJson.confidence : 0.5,
      reminderAt: typeof parsedJson.reminderAt === "string" ? parsedJson.reminderAt : null,
      shouldSave: Boolean(parsedJson.shouldSave),
      responseMode:
        parsedResponseMode === "reply_only" ||
        parsedResponseMode === "saved" ||
        parsedResponseMode === "suggest_actions" ||
        parsedResponseMode === "action_executed"
          ? parsedResponseMode
          : "reply_only",
    };
  } catch (err) {
    logger.warn({ err }, "AI-классификация не удалась, применяем fallback");

    const lowerContent = content.toLowerCase();
    if (EXPLICIT_SAVE_REMINDER_RE.test(lowerContent)) {
      classification.intentType = "save_reminder";
      classification.type = "reminder";
      classification.shouldSave = true;
      classification.confidence = 0.75;
      classification.responseMode = "saved";
    } else if (EXPLICIT_SAVE_NOTE_RE.test(lowerContent)) {
      classification.intentType = "save_note";
      classification.type = "note";
      classification.shouldSave = true;
      classification.confidence = 0.7;
      classification.responseMode = "saved";
    } else if (ACTION_ON_EXISTING_RE.test(lowerContent)) {
      classification.intentType = "action_on_existing";
      classification.type = "chat";
      classification.shouldSave = false;
      classification.confidence = 0.7;
      classification.responseMode = "action_executed";
    } else if (looksLikeFutureReminderIntent(lowerContent) || AMBIGUOUS_REMINDER_RE.test(lowerContent)) {
      classification.intentType = "chat_only";
      classification.type = "chat";
      classification.shouldSave = false;
      classification.confidence = 0.6;
      classification.responseMode = "suggest_actions";
    } else {
      classification.intentType = "chat_only";
      classification.type = "chat";
      classification.shouldSave = false;
      classification.confidence = 0.6;
      classification.responseMode = "reply_only";
    }
  }

  const lowerContent = content.toLowerCase();
  const explicitReminder = EXPLICIT_SAVE_REMINDER_RE.test(lowerContent);
  const explicitNote = EXPLICIT_SAVE_NOTE_RE.test(lowerContent);
  const actionRequest = ACTION_ON_EXISTING_RE.test(lowerContent);
  const ambiguousReminder = looksLikeFutureReminderIntent(lowerContent) || AMBIGUOUS_REMINDER_RE.test(lowerContent);

  if (actionRequest) {
    classification.intentType = "action_on_existing";
    classification.type = "chat";
    classification.shouldSave = false;
    classification.responseMode = "action_executed";
  } else if (explicitReminder) {
    classification.intentType = "save_reminder";
    classification.type = "reminder";
    classification.shouldSave = true;
    classification.responseMode = "saved";
  } else if (explicitNote) {
    classification.intentType = "save_note";
    classification.type = "note";
    classification.shouldSave = true;
    classification.responseMode = "saved";
  } else if (classification.intentType === "save_note" || classification.intentType === "save_reminder") {
    if (classification.confidence >= 0.82) {
      classification.shouldSave = true;
      classification.responseMode = "saved";
      classification.type = classification.intentType === "save_reminder" ? "reminder" : "note";
    } else {
      classification.intentType = "chat_only";
      classification.type = "chat";
      classification.shouldSave = false;
      classification.responseMode = "suggest_actions";
    }
  } else if (ambiguousReminder && classification.confidence < 0.85) {
    classification.intentType = "chat_only";
    classification.type = "chat";
    classification.shouldSave = false;
    classification.responseMode = "suggest_actions";
  } else if (!classification.shouldSave) {
    classification.intentType = "chat_only";
    classification.type = "chat";
    classification.responseMode =
      ambiguousReminder || classification.responseMode === "suggest_actions"
        ? "suggest_actions"
        : "reply_only";
  }

  const buildSavedItemResponse = (
    record: typeof itemsTable.$inferSelect,
    folderName: string | null,
  ) => ({
    id: record.id,
    userId: record.userId,
    folderId: record.folderId ?? null,
    folderName,
    type: record.type,
    title: record.title,
    content: record.content ?? null,
    summary: record.summary ?? null,
    originalFilename: record.originalFilename ?? null,
    mimeType: record.mimeType ?? null,
    fileSize: record.fileSize ?? null,
    fileData: record.fileData ?? null,
    reminderAt: record.reminderAt ? record.reminderAt.toISOString() : null,
    status: record.status,
    aiCategory: record.aiCategory ?? null,
    aiTags: (record.aiTags as string[]) ?? [],
    aiConfidence: record.aiConfidence ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });

  const buildAssistantSavedItem = (
    record: typeof itemsTable.$inferSelect,
    folderName: string | null,
  ): NonNullable<AssistantContext>["savedItem"] => ({
    id: record.id,
    type: record.type,
    title: record.title,
    folderId: record.folderId ?? null,
    folderName,
    reminderAt: record.reminderAt ? record.reminderAt.toISOString() : null,
  });

  let savedItem: ReturnType<typeof buildSavedItemResponse> | null = null;
  let assistantSavedItem: NonNullable<AssistantContext>["savedItem"] = null;
  let suggestedActions: Array<"save_note" | "save_reminder" | "ignore"> = [];
  let message = "";

  if (classification.intentType === "action_on_existing") {
    const moveResult = await tryHandleMoveLatestAction({
      content,
      userId,
      folders: userFolders,
    });

    if (moveResult) {
      classification.responseMode = "action_executed";
      classification.shouldSave = false;
      classification.type = moveResult.item.type;
      const folderName = moveResult.folder.name;
      savedItem = buildSavedItemResponse(moveResult.item, folderName);
      assistantSavedItem = buildAssistantSavedItem(moveResult.item, folderName);
      message = `Готово: объект «${moveResult.item.title}» перемещён в папку «${folderName}».`;
    } else {
      classification.intentType = "chat_only";
      classification.type = "chat";
      classification.shouldSave = false;
      classification.responseMode = "reply_only";
      message =
        "Пока не удалось выполнить действие над существующим объектом автоматически. Уточните, какой объект изменить и в какую папку его перенести.";
    }
  } else if (classification.shouldSave && (classification.type === "note" || classification.type === "reminder")) {
    let folderId: number | null = contextualFolderId;

    if (!folderId && classification.suggestedFolder) {
      const matchedFolder = userFolders.find(
        (folder) => folder.name.toLowerCase() === classification.suggestedFolder!.toLowerCase(),
      );
      if (matchedFolder) folderId = matchedFolder.id;
    }

    if (!folderId) {
      const folderCandidates =
        classification.type === "reminder"
          ? ["Напоминания", "Reminders"]
          : ["Заметки", "Notes"];

      const defaultFolder = userFolders.find((folder) =>
        folderCandidates.some((candidate) => candidate.toLowerCase() === folder.name.toLowerCase()),
      );

      if (defaultFolder) folderId = defaultFolder.id;
    }

    let parsedReminderDate: Date | null = null;
    try {
      parsedReminderDate = parseReminderDateTime(classification.reminderAt);
    } catch (err) {
      logger.warn({ err }, "Не удалось распознать дату напоминания, сохраняем без времени");
      classification.reminderAt = null;
    }

    const [savedRecord] = await db
      .insert(itemsTable)
      .values({
        userId,
        type: classification.type as "note" | "reminder",
        title: classification.title ?? content.slice(0, 60),
        content: classification.cleanedContent ?? content,
        summary: classification.summary,
        folderId,
        reminderAt: parsedReminderDate,
        status: "active",
        aiCategory: classification.suggestedFolder,
        aiTags: classification.tags,
        aiConfidence: classification.confidence,
      })
      .returning();

    classification.intentType = savedRecord.type === "reminder" ? "save_reminder" : "save_note";
    classification.type = savedRecord.type;
    classification.responseMode = "saved";
    classification.shouldSave = true;

    if (parsedReminderDate) {
      classification.reminderAt = parsedReminderDate.toISOString();
    }

    let folderName: string | null = null;
    if (folderId) {
      const folder = userFolders.find((entry) => entry.id === folderId);
      folderName = folder?.name ?? null;
    }

    savedItem = buildSavedItemResponse(savedRecord, folderName);
    assistantSavedItem = buildAssistantSavedItem(savedRecord, folderName);

    if (savedRecord.type === "reminder") {
      const reminderPart = parsedReminderDate ? ` на ${formatMoscowDateTime(parsedReminderDate)}` : "";
      message = `Сохранил как напоминание «${savedRecord.title}»${folderName ? ` в папку «${folderName}»` : ""}${reminderPart}.`;
    } else {
      message = `Сохранил как заметку «${savedRecord.title}»${folderName ? ` в папку «${folderName}»` : ""}.`;
    }
  } else if (classification.responseMode === "suggest_actions") {
    classification.intentType = "chat_only";
    classification.type = "chat";
    classification.shouldSave = false;
    suggestedActions = ["save_note", "save_reminder", "ignore"];
    message =
      "Не стал автоматически сохранять это сообщение. Выберите, что сделать: сохранить как заметку, создать напоминание или оставить как обычный чат.";
  } else {
    classification.intentType = "chat_only";
    classification.type = "chat";
    classification.shouldSave = false;
    classification.responseMode = "reply_only";
    message = "Понял запрос. Отвечаю в чате без автоматического сохранения.";
  }

  const assistantContext: AssistantContext = {
    intentType: classification.intentType,
    responseMode: classification.responseMode,
    autoSaved: classification.responseMode === "saved" && Boolean(savedItem),
    assistantReply: message,
    savedItem: assistantSavedItem,
    suggestedActions: suggestedActions.length > 0 ? suggestedActions : undefined,
  };

  res.json({
    type: classification.type,
    intentType: classification.intentType,
    responseMode: classification.responseMode,
    shouldSave: classification.shouldSave,
    title: classification.title,
    summary: classification.summary,
    cleanedContent: classification.cleanedContent,
    suggestedFolder: classification.suggestedFolder,
    tags: classification.tags,
    confidence: classification.confidence,
    reminderAt: classification.reminderAt,
    savedItem,
    suggestedActions: assistantContext?.suggestedActions ?? [],
    assistantContext,
    message,
  });
});

export default router;
