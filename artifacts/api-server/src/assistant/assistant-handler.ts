import { desc, eq } from "drizzle-orm";
import { db, foldersTable, messages } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  classifyAndExecuteAssistantAction,
  createCancelledResponse,
  createClarificationResponse,
  executeKeywordCommand,
  executeValidatedAssistantIntent,
  type AssistantActionResponse,
} from "./actions";
import { classifyAssistantIntent } from "./ai-intent-classifier";
import { assistantIntentSchema } from "./assistant-intent";
import {
  applyProfileMemoryUpdates,
  formatContextLayersForPrompt,
  type AssistantContextLayers,
} from "./assistant-memory";
import {
  attachUndoOperation,
  captureAssistantSnapshot,
} from "./assistant-undo";
import type {
  AssistantActionSelection,
  AssistantSelectableIntent,
  PendingAssistantAction,
} from "./assistant-contract";
import {
  normalizeText,
  parseListCommand,
  parseReminderCommand,
  titleFromText,
} from "./command-parser";

type HandleAssistantMessageParams = {
  userId: number;
  conversationId: number;
  text: string;
  model: string;
  folderId?: number | null;
  selection?: AssistantActionSelection | null;
  contextLayers: AssistantContextLayers;
};

const CANCEL_RE = /^(отмена|отмени|не надо|не сохраняй|нет|оставь|стоп|cancel)$/i;
const CONFIRM_RE = /^(да|подтверждаю|подтвердить|удали|выполнить|ок|хорошо)$/i;

function isPendingAssistantAction(value: unknown): value is PendingAssistantAction {
  if (!value || typeof value !== "object") return false;
  const source = value as Record<string, unknown>;
  return (
    typeof source.id === "string" &&
    (source.kind === "choose_intent" ||
      source.kind === "choose_target" ||
      source.kind === "confirm_action") &&
    source.status === "pending" &&
    typeof source.originalMessage === "string" &&
    typeof source.expiresAt === "string" &&
    source.payload !== null &&
    typeof source.payload === "object"
  );
}

async function getLatestStructuredPendingAction(
  conversationId: number,
): Promise<PendingAssistantAction | null> {
  const rows = await db
    .select({ role: messages.role, metadata: messages.metadata })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(6);

  let userMessages = 0;
  for (const row of rows) {
    if (row.role === "user") {
      userMessages += 1;
      if (userMessages > 1) return null;
      continue;
    }
    if (row.role !== "assistant" || !row.metadata) return null;
    const pending = (row.metadata as Record<string, unknown>).pendingAction;
    if (!isPendingAssistantAction(pending)) return null;
    if (new Date(pending.expiresAt).getTime() <= Date.now()) return null;
    return pending;
  }
  return null;
}

function selectedIntentFromText(
  text: string,
): AssistantSelectableIntent | null {
  const normalized = normalizeText(text);
  if (CANCEL_RE.test(normalized)) return "cancel";
  if (/заметк|запис|сохрани/.test(normalized)) return "create_note";
  if (/список|чеклист/.test(normalized)) return "create_list";
  if (/напомин/.test(normalized)) return "create_reminder";
  return null;
}

async function executeSelectedIntent({
  selectedIntent,
  pending,
  userId,
  folderId,
}: {
  selectedIntent: AssistantSelectableIntent;
  pending: PendingAssistantAction;
  userId: number;
  folderId?: number | null;
}): Promise<AssistantActionResponse> {
  if (selectedIntent === "cancel") {
    return createCancelledResponse();
  }

  const folders = await db
    .select()
    .from(foldersTable)
    .where(eq(foldersTable.userId, userId));

  if (selectedIntent === "create_note") {
    return executeKeywordCommand({
      command: { kind: "note", text: pending.originalMessage },
      userId,
      folders,
      folderId,
    });
  }

  if (selectedIntent === "create_list") {
    const parsed = parseListCommand(pending.originalMessage);
    const listText = parsed
      ? `${parsed.title}: ${parsed.items.join(", ")}`
      : `Список: ${pending.originalMessage}`;
    return executeKeywordCommand({
      command: { kind: "list", text: listText },
      userId,
      folders,
      folderId,
    });
  }

  const parsedReminder = parseReminderCommand(pending.originalMessage);
  return executeKeywordCommand({
    command: {
      kind: "reminder",
      text: parsedReminder.text
        ? pending.originalMessage
        : titleFromText(pending.originalMessage, "Новое напоминание"),
    },
    userId,
    folders,
    folderId,
  });
}

async function resolveStructuredPendingAction({
  pending,
  selection,
  text,
  userId,
  folderId,
}: {
  pending: PendingAssistantAction;
  selection?: AssistantActionSelection | null;
  text: string;
  userId: number;
  folderId?: number | null;
}): Promise<AssistantActionResponse | null> {
  if (selection?.pendingActionId && selection.pendingActionId !== pending.id) {
    return createClarificationResponse(
      "Это действие уже устарело. Повторите команду.",
    );
  }

  if (selection?.cancel || CANCEL_RE.test(normalizeText(text))) {
    return createCancelledResponse();
  }

  if (pending.kind === "choose_intent") {
    const selectedIntent =
      selection?.selectedIntent ?? selectedIntentFromText(text);
    if (
      !selectedIntent ||
      !pending.possibleIntents?.includes(selectedIntent)
    ) {
      return createClarificationResponse(
        "Выберите, что сделать с исходным сообщением.",
      );
    }
    return executeSelectedIntent({
      selectedIntent,
      pending,
      userId,
      folderId,
    });
  }

  const rawIntent = pending.payload.intent;
  const parsedIntent = assistantIntentSchema.safeParse(rawIntent);
  if (!parsedIntent.success) {
    return createClarificationResponse(
      "Не удалось восстановить ожидающее действие. Повторите команду.",
    );
  }

  if (pending.kind === "choose_target") {
    const selectedItemId =
      selection?.selectedItemId ??
      pending.targetCandidates?.find(
        (candidate) =>
          normalizeText(candidate.title) === normalizeText(text) ||
          String(candidate.id) === text.trim(),
      )?.id;
    if (!selectedItemId) {
      return createClarificationResponse("Выберите один из найденных объектов.");
    }
    return executeValidatedAssistantIntent({
      intent: parsedIntent.data,
      userId,
      originalMessage: pending.originalMessage,
      folderId,
      selectedItemId,
    });
  }

  const confirmed = selection?.confirm || CONFIRM_RE.test(normalizeText(text));
  if (!confirmed) {
    return createClarificationResponse(
      "Подтвердите действие или нажмите «Отмена».",
    );
  }
  const selectedItemId =
    selection?.selectedItemId ??
    (typeof pending.payload.selectedItemId === "number"
      ? pending.payload.selectedItemId
      : undefined);
  return executeValidatedAssistantIntent({
    intent: parsedIntent.data,
    userId,
    originalMessage: pending.originalMessage,
    folderId,
    selectedItemId,
    confirmed: true,
  });
}

export async function handleAssistantMessage({
  userId,
  conversationId,
  text,
  model,
  folderId,
  selection,
  contextLayers,
}: HandleAssistantMessageParams): Promise<AssistantActionResponse> {
  const pending = await getLatestStructuredPendingAction(conversationId);
  if (selection?.pendingActionId && !pending) {
    return createClarificationResponse(
      "Это действие уже выполнено или устарело. Повторите команду при необходимости.",
    );
  }
  if (pending) {
    const before = await captureAssistantSnapshot(userId);
    const resolved = await resolveStructuredPendingAction({
      pending,
      selection,
      text,
      userId,
      folderId,
    });
    if (resolved) {
      return attachUndoOperation({
        userId,
        conversationId,
        before,
        response: resolved,
      });
    }
  }

  const folders = await db
    .select()
    .from(foldersTable)
    .where(eq(foldersTable.userId, userId));
  const classification = await classifyAssistantIntent({
    message: text,
    folderNames: folders.map((folder) => folder.name),
    model,
    context: formatContextLayersForPrompt(contextLayers, {
      includeRelevantObjects: true,
    }),
  });

  if (classification.status === "valid") {
    logger.info(
      {
        userId,
        conversationId,
        intent: classification.value.intent,
      },
      "[assistant] AI-first intent classified",
    );
    await applyProfileMemoryUpdates({
      userId,
      sourceMessage: text,
      updates: classification.value.memory?.facts,
    });
    const before = await captureAssistantSnapshot(userId);
    const response = await executeValidatedAssistantIntent({
      intent: classification.value,
      userId,
      originalMessage: text,
      folderId,
      folders,
    });
    return attachUndoOperation({
      userId,
      conversationId,
      before,
      response,
    });
  }

  if (classification.status === "invalid") {
    logger.warn(
      { userId, conversationId, reason: classification.reason },
      "[assistant] classifier response rejected",
    );
    return createClarificationResponse(
      "Не совсем понял запрос. Сформулируйте его немного иначе.",
    );
  }

  logger.warn(
    { userId, conversationId, reason: classification.reason },
    "[assistant] AI unavailable, using deterministic fallback",
  );
  const before = await captureAssistantSnapshot(userId);
  const response = await classifyAndExecuteAssistantAction({
    userId,
    content: text,
    conversationId,
    folderId,
  });
  return attachUndoOperation({
    userId,
    conversationId,
    before,
    response,
  });
}
