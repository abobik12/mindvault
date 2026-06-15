export function buildOfflineAssistantReply(
  userMessage: string,
  contextSummary?: string | null,
): string {
  if (!userMessage.trim()) {
    return "Введите сообщение.";
  }
  if (contextSummary) {
    return contextSummary;
  }
  return "Сейчас не удалось подготовить ответ. Попробуйте чуть позже.";
}
