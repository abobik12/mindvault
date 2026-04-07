import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
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

const router: IRouter = Router();

// GET /gemini/conversations
router.get("/gemini/conversations", requireAuth, async (req, res): Promise<void> => {
  const convs = await db.select().from(conversations)
    .where(eq(conversations.userId, req.auth!.userId))
    .orderBy(conversations.createdAt);

  res.json(convs.map((c) => ({
    id: c.id,
    title: c.title,
    createdAt: c.createdAt.toISOString(),
  })));
});

// POST /gemini/conversations
router.post("/gemini/conversations", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateGeminiConversationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [conv] = await db.insert(conversations).values({
    userId: req.auth!.userId,
    title: parsed.data.title,
  }).returning();

  res.status(201).json({
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt.toISOString(),
  });
});

// GET /gemini/conversations/:id
router.get("/gemini/conversations/:id", requireAuth, async (req, res): Promise<void> => {
  const params = GetGeminiConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [conv] = await db.select().from(conversations)
    .where(and(eq(conversations.id, params.data.id), eq(conversations.userId, req.auth!.userId)))
    .limit(1);

  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  const msgs = await db.select().from(messages)
    .where(eq(messages.conversationId, conv.id))
    .orderBy(messages.createdAt);

  res.json({
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt.toISOString(),
    messages: msgs.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
    })),
  });
});

// DELETE /gemini/conversations/:id
router.delete("/gemini/conversations/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteGeminiConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db.delete(conversations)
    .where(and(eq(conversations.id, params.data.id), eq(conversations.userId, req.auth!.userId)))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  res.sendStatus(204);
});

// GET /gemini/conversations/:id/messages
router.get("/gemini/conversations/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const params = ListGeminiMessagesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [conv] = await db.select().from(conversations)
    .where(and(eq(conversations.id, params.data.id), eq(conversations.userId, req.auth!.userId)))
    .limit(1);

  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  const msgs = await db.select().from(messages)
    .where(eq(messages.conversationId, conv.id))
    .orderBy(messages.createdAt);

  res.json(msgs.map((m) => ({
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
  })));
});

// POST /gemini/conversations/:id/messages (SSE streaming)
router.post("/gemini/conversations/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const params = SendGeminiMessageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const bodyParsed = SendGeminiMessageBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: bodyParsed.error.message });
    return;
  }

  const [conv] = await db.select().from(conversations)
    .where(and(eq(conversations.id, params.data.id), eq(conversations.userId, req.auth!.userId)))
    .limit(1);

  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  // Save user message
  const [userMessage] = await db.insert(messages).values({
    conversationId: conv.id,
    role: "user",
    content: bodyParsed.data.content,
  }).returning();

  // Load chat history for context
  const chatHistory = await db.select().from(messages)
    .where(eq(messages.conversationId, conv.id))
    .orderBy(messages.createdAt);

  // Build system prompt for MindVault assistant
  const systemPrompt = `You are the MindVault AI assistant — a personal knowledge and productivity assistant. 
You help users organize their thoughts, save notes, set reminders, and manage their personal workspace.

When users share content with you:
- Be helpful and conversational
- If you saved something for them (which happens automatically), acknowledge it naturally
- Answer questions about their saved content when asked
- Help them think through ideas
- Keep responses concise but thoughtful

You are integrated into the user's personal workspace. Be warm, smart, and efficient.`;

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  let fullResponse = "";

  try {
    const contentsForGemini = [
      { role: "user" as const, parts: [{ text: systemPrompt }] },
      { role: "model" as const, parts: [{ text: "Understood. I'm ready to help you organize your thoughts and manage your personal workspace." }] },
      ...chatHistory.slice(0, -1).map((m) => ({
        role: (m.role === "assistant" ? "model" : "user") as "user" | "model",
        parts: [{ text: m.content }],
      })),
      { role: "user" as const, parts: [{ text: bodyParsed.data.content }] },
    ];

    const stream = await ai.models.generateContentStream({
      model: "gemini-2.5-flash",
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

    // Save assistant message
    await db.insert(messages).values({
      conversationId: conv.id,
      role: "assistant",
      content: fullResponse,
    });

    // Update conversation title if it's the first exchange
    if (chatHistory.length <= 2) {
      const titlePrompt = `Generate a short 4-6 word title for a conversation that starts with: "${bodyParsed.data.content.slice(0, 100)}". Reply with ONLY the title, no quotes.`;
      try {
        const titleResponse = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [{ role: "user", parts: [{ text: titlePrompt }] }],
          config: { maxOutputTokens: 50 },
        });
        const newTitle = titleResponse.text?.trim();
        if (newTitle) {
          await db.update(conversations).set({ title: newTitle }).where(eq(conversations.id, conv.id));
        }
      } catch (err) {
        logger.warn({ err }, "Failed to generate conversation title");
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (err) {
    logger.error({ err }, "Error streaming Gemini response");
    res.write(`data: ${JSON.stringify({ error: "AI response failed" })}\n\n`);
  }

  res.end();
});

// POST /gemini/classify - AI classification with auto-save
router.post("/gemini/classify", requireAuth, async (req, res): Promise<void> => {
  const parsed = ClassifyContentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { content } = parsed.data;
  const userId = req.auth!.userId;

  // Get user's folders for context
  const userFolders = await db.select({ id: foldersTable.id, name: foldersTable.name })
    .from(foldersTable)
    .where(eq(foldersTable.userId, userId));

  const folderNames = userFolders.map((f) => f.name).join(", ");

  const classifyPrompt = `You are an intelligent content classifier for a personal knowledge management system called MindVault.

Analyze this user input and classify it:
"${content}"

Available folders: ${folderNames || "Inbox, Notes, Files, Reminders"}

Respond ONLY with valid JSON in this exact format:
{
  "type": "note" | "reminder" | "file" | "chat",
  "title": "string or null",
  "summary": "string or null",
  "cleanedContent": "string or null (improved/structured version of the content for notes)",
  "suggestedFolder": "string matching one of the available folders or null",
  "tags": ["array", "of", "relevant", "tags"],
  "confidence": 0.0 to 1.0,
  "reminderAt": "ISO date string or null",
  "shouldSave": true | false
}

Classification rules:
- "note": ideas, thoughts, information to remember, any text to save
- "reminder": anything with time context ("tomorrow", "at X:XX", "remind me", specific dates)
- "file": references to files being uploaded (usually not via text input)
- "chat": pure questions, commands, or conversational messages that don't need saving

For reminders: extract the specific date/time. If "tomorrow" use tomorrow's date. Current date: ${new Date().toISOString()}
For notes: improve formatting and structure the content if it's rough
Only set shouldSave=true for note or reminder types, not for chat messages`;

  let classification = {
    type: "chat" as "note" | "reminder" | "file" | "chat",
    title: null as string | null,
    summary: null as string | null,
    cleanedContent: null as string | null,
    suggestedFolder: null as string | null,
    tags: [] as string[],
    confidence: 0.5,
    reminderAt: null as string | null,
    shouldSave: false,
  };

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: classifyPrompt }] }],
      config: {
        responseMimeType: "application/json",
        maxOutputTokens: 8192,
      },
    });

    const rawJson = response.text ?? "{}";
    const parsed = JSON.parse(rawJson);

    classification = {
      type: ["note", "reminder", "file", "chat"].includes(parsed.type) ? parsed.type : "chat",
      title: typeof parsed.title === "string" ? parsed.title : null,
      summary: typeof parsed.summary === "string" ? parsed.summary : null,
      cleanedContent: typeof parsed.cleanedContent === "string" ? parsed.cleanedContent : null,
      suggestedFolder: typeof parsed.suggestedFolder === "string" ? parsed.suggestedFolder : null,
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t: unknown) => typeof t === "string") : [],
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      reminderAt: typeof parsed.reminderAt === "string" ? parsed.reminderAt : null,
      shouldSave: Boolean(parsed.shouldSave),
    };
  } catch (err) {
    logger.warn({ err }, "AI classification failed, using fallback");

    // Fallback logic
    const lowerContent = content.toLowerCase();
    const timePatterns = /\b(tomorrow|tonight|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}:\d{2}|remind|at \d|next week)\b/i;

    if (timePatterns.test(lowerContent)) {
      classification.type = "reminder";
      classification.shouldSave = true;
      classification.confidence = 0.6;
    } else if (content.length > 20) {
      classification.type = "note";
      classification.shouldSave = true;
      classification.confidence = 0.5;
    }
  }

  let savedItem = null;
  let message = "";

  // Auto-save if appropriate
  if (classification.shouldSave && (classification.type === "note" || classification.type === "reminder")) {
    // Find the suggested folder
    let folderId: number | null = null;
    if (classification.suggestedFolder) {
      const matchedFolder = userFolders.find((f) =>
        f.name.toLowerCase() === classification.suggestedFolder!.toLowerCase()
      );
      if (matchedFolder) folderId = matchedFolder.id;
    }

    // Default folder fallback
    if (!folderId) {
      const defaultFolderName = classification.type === "reminder" ? "Reminders" : "Notes";
      const defaultFolder = userFolders.find((f) => f.name.toLowerCase() === defaultFolderName.toLowerCase());
      if (defaultFolder) folderId = defaultFolder.id;
    }

    const [savedRecord] = await db.insert(itemsTable).values({
      userId,
      type: classification.type as "note" | "reminder",
      title: classification.title ?? content.slice(0, 60),
      content: classification.cleanedContent ?? content,
      summary: classification.summary,
      folderId,
      reminderAt: classification.reminderAt ? new Date(classification.reminderAt) : null,
      status: "active",
      aiCategory: classification.suggestedFolder,
      aiTags: classification.tags,
      aiConfidence: classification.confidence,
    }).returning();

    let folderName: string | null = null;
    if (folderId) {
      const folder = userFolders.find((f) => f.id === folderId);
      folderName = folder?.name ?? null;
    }

    savedItem = {
      id: savedRecord.id,
      userId: savedRecord.userId,
      folderId: savedRecord.folderId ?? null,
      folderName,
      type: savedRecord.type,
      title: savedRecord.title,
      content: savedRecord.content ?? null,
      summary: savedRecord.summary ?? null,
      originalFilename: null,
      mimeType: null,
      fileSize: null,
      fileData: null,
      reminderAt: savedRecord.reminderAt ? savedRecord.reminderAt.toISOString() : null,
      status: savedRecord.status,
      aiCategory: savedRecord.aiCategory ?? null,
      aiTags: (savedRecord.aiTags as string[]) ?? [],
      aiConfidence: savedRecord.aiConfidence ?? null,
      createdAt: savedRecord.createdAt.toISOString(),
      updatedAt: savedRecord.updatedAt.toISOString(),
    };

    if (classification.type === "reminder") {
      message = `Reminder "${savedItem.title}" saved${folderName ? ` to ${folderName}` : ""}${classification.reminderAt ? ` for ${new Date(classification.reminderAt).toLocaleString()}` : ""}.`;
    } else {
      message = `Note "${savedItem.title}" saved${folderName ? ` to ${folderName}` : ""}.`;
    }
  } else {
    message = "Got it! How can I help you?";
  }

  res.json({
    type: classification.type,
    title: classification.title,
    summary: classification.summary,
    cleanedContent: classification.cleanedContent,
    suggestedFolder: classification.suggestedFolder,
    tags: classification.tags,
    confidence: classification.confidence,
    reminderAt: classification.reminderAt,
    savedItem,
    message,
  });
});

export default router;
