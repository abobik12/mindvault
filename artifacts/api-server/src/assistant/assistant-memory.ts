import { and, asc, desc, eq, gt } from "drizzle-orm";
import {
  conversations,
  db,
  messages,
  usersTable,
  type Message,
} from "@workspace/db";
import { ai } from "@workspace/integrations-gemini-ai";
import {
  buildAssistantContext,
  type UserContextData,
} from "../lib/ai-context";
import { logger } from "../lib/logger";

export type MemoryCategory =
  | "person"
  | "alias"
  | "slang"
  | "preference"
  | "project"
  | "habit";

export type ProfileFact = {
  category: MemoryCategory;
  key: string;
  value: string;
  mentions: number;
  updatedAt: string;
};

export type AssistantProfile = { facts: ProfileFact[] };

export type ProfileMemoryUpdate = {
  category: MemoryCategory;
  key: string;
  value: string;
};

export type AssistantContextLayers = {
  summary: string | null;
  recentMessages: Message[];
  profile: AssistantProfile;
  userContext: UserContextData;
};

const RECENT_MESSAGE_LIMIT = 14;
const SUMMARY_BATCH_LIMIT = 60;
const DURABLE_MEMORY_RE =
  /(?:^|[^\p{L}])(запомни|обычно|всегда|никогда|предпочитаю|люблю|не люблю|я называю|мы называем|для меня|мой проект|работаю над|привык|как правило)(?=$|[^\p{L}])/iu;

function normalize(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

export function shouldPersistProfileMemory(message: string): boolean {
  return DURABLE_MEMORY_RE.test(message);
}

export function mergeProfileFacts(
  profile: AssistantProfile,
  updates: ProfileMemoryUpdate[],
  now = new Date(),
): AssistantProfile {
  const facts = [...profile.facts];
  for (const update of updates.slice(0, 5)) {
    const key = update.key.trim();
    const value = update.value.trim();
    if (!key || !value) continue;
    const existingIndex = facts.findIndex(
      (fact) =>
        fact.category === update.category &&
        normalize(fact.key) === normalize(key),
    );
    const nextFact: ProfileFact = {
      category: update.category,
      key,
      value,
      mentions:
        existingIndex >= 0 ? Math.min(facts[existingIndex].mentions + 1, 999) : 1,
      updatedAt: now.toISOString(),
    };
    if (existingIndex >= 0) facts[existingIndex] = nextFact;
    else facts.push(nextFact);
  }

  return {
    facts: facts
      .sort((a, b) => b.mentions - a.mentions || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 80),
  };
}

async function updateConversationSummary({
  conversationId,
  existingSummary,
  summaryThroughMessageId,
  model,
}: {
  conversationId: number;
  existingSummary: string | null;
  summaryThroughMessageId: number | null;
  model: string;
}): Promise<{ summary: string | null; summaryThroughMessageId: number | null }> {
  const unsummarized = await db
    .select()
    .from(messages)
    .where(
      summaryThroughMessageId
        ? and(
            eq(messages.conversationId, conversationId),
            gt(messages.id, summaryThroughMessageId),
          )
        : eq(messages.conversationId, conversationId),
    )
    .orderBy(asc(messages.id))
    .limit(SUMMARY_BATCH_LIMIT);

  if (unsummarized.length <= RECENT_MESSAGE_LIMIT) {
    return { summary: existingSummary, summaryThroughMessageId };
  }

  const toSummarize = unsummarized.slice(0, -RECENT_MESSAGE_LIMIT);
  const transcript = toSummarize
    .map((message) => `${message.role === "assistant" ? "Ассистент" : "Пользователь"}: ${message.content}`)
    .join("\n");

  try {
    const result = await ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: [
                "Обнови краткое резюме старой части диалога MindVault.",
                "Сохрани только решения, устойчивый контекст, упомянутых людей, проекты и незавершённые ссылки.",
                "Не добавляй случайные реплики. Ответь по-русски, не более 900 символов.",
                existingSummary ? `Предыдущее резюме:\n${existingSummary}` : "",
                `Новые сообщения:\n${transcript}`,
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          ],
        },
      ],
      config: { maxOutputTokens: 450 },
    });
    const summary = result.text?.replace(/\s+/g, " ").trim().slice(0, 1200);
    if (!summary) return { summary: existingSummary, summaryThroughMessageId };

    const throughId = toSummarize[toSummarize.length - 1]?.id ?? null;
    await db
      .update(conversations)
      .set({ summary, summaryThroughMessageId: throughId })
      .where(eq(conversations.id, conversationId));
    return { summary, summaryThroughMessageId: throughId };
  } catch (error) {
    logger.warn(
      { conversationId, errorMessage: error instanceof Error ? error.message : String(error) },
      "[assistant-memory] summary update skipped",
    );
    return { summary: existingSummary, summaryThroughMessageId };
  }
}

export async function prepareAssistantContextLayers({
  userId,
  conversationId,
  currentMessage,
  model,
}: {
  userId: number;
  conversationId: number;
  currentMessage: string;
  model: string;
}): Promise<AssistantContextLayers> {
  const [[conversation], [user], userContext] = await Promise.all([
    db
      .select({
        summary: conversations.summary,
        summaryThroughMessageId: conversations.summaryThroughMessageId,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.userId, userId),
        ),
      )
      .limit(1),
    db
      .select({ assistantProfile: usersTable.assistantProfile })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1),
    buildAssistantContext(userId, currentMessage, conversationId, {
      maxRecentItems: 6,
      maxSearchResults: 8,
      includeArchived: false,
    }),
  ]);

  const summaryState = conversation
    ? await updateConversationSummary({
        conversationId,
        existingSummary: conversation.summary,
        summaryThroughMessageId: conversation.summaryThroughMessageId,
        model,
      })
    : { summary: null, summaryThroughMessageId: null };

  const recentMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.id))
    .limit(RECENT_MESSAGE_LIMIT);

  return {
    summary: summaryState.summary,
    recentMessages: recentMessages.reverse(),
    profile: user?.assistantProfile ?? { facts: [] },
    userContext,
  };
}

export async function applyProfileMemoryUpdates({
  userId,
  sourceMessage,
  updates,
}: {
  userId: number;
  sourceMessage: string;
  updates: ProfileMemoryUpdate[] | undefined;
}): Promise<void> {
  if (!updates?.length || !shouldPersistProfileMemory(sourceMessage)) return;

  const [user] = await db
    .select({ assistantProfile: usersTable.assistantProfile })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!user) return;

  const nextProfile = mergeProfileFacts(
    user.assistantProfile ?? { facts: [] },
    updates,
  );
  await db
    .update(usersTable)
    .set({ assistantProfile: nextProfile })
    .where(eq(usersTable.id, userId));
}

export function formatContextLayersForPrompt(
  layers: AssistantContextLayers,
  options: { includeRelevantObjects: boolean },
): string {
  const sections: string[] = [];

  if (layers.summary) {
    sections.push(`Резюме более старой части диалога:\n${layers.summary}`);
  }
  if (layers.profile.facts.length > 0) {
    sections.push(
      [
        "Устойчивый профиль пользователя:",
        ...layers.profile.facts
          .slice(0, 30)
          .map((fact) => `- [${fact.category}] ${fact.key}: ${fact.value}`),
      ].join("\n"),
    );
  }
  if (options.includeRelevantObjects && layers.userContext.relevantSources.length > 0) {
    sections.push(
      [
        "Релевантные личные объекты:",
        ...layers.userContext.relevantSources.slice(0, 8).map((source) => {
          const folder = source.folderName || source.folder;
          const details = [folder ? `папка: ${folder}` : "", source.date ? `дата: ${source.date}` : ""]
            .filter(Boolean)
            .join(", ");
          return `- [${source.type}] id=${source.id ?? "нет"} «${source.title}»${details ? ` (${details})` : ""}: ${source.excerpt}`;
        }),
      ].join("\n"),
    );
  }

  if (sections.length === 0) return "";
  return [
    "\n\n---",
    "Персональный контекст MindVault. Он относится только к текущему пользователю.",
    "Используй только действительно релевантные сведения и не раскрывай устройство памяти.",
    ...sections,
    "---",
  ].join("\n\n");
}
