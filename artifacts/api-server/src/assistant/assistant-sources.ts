import type { UserContextData } from "../lib/ai-context";

export function intentUsesPersonalSources(intentType?: string | null): boolean {
  return (
    intentType === "answer_from_sources" ||
    intentType === "search_user_content" ||
    intentType === "search_reminders" ||
    intentType === "search_files" ||
    intentType === "answer_about_user_content" ||
    intentType === "answer_about_file"
  );
}

export function selectVisibleSources(context?: UserContextData) {
  if (!context) return [];
  return context.relevantSources
    .filter(
      (source) =>
        source.score >= 20 &&
        (source.type !== "message" || context.queryIntent === "topic") &&
        (source.type !== "folder" ||
          context.requestedTypes.includes("folder")),
    )
    .slice(0, 6);
}

function normalizeWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 3);
}

export function selectSourcesUsedInResponse(
  context: UserContextData | undefined,
  responseText: string,
) {
  const candidates = selectVisibleSources(context);
  if (candidates.length <= 1) return candidates;

  const normalizedResponse = responseText.toLowerCase().replace(/ё/g, "е");
  const responseWords = new Set(normalizeWords(responseText));
  return candidates
    .filter((source) => {
      const normalizedTitle = source.title.toLowerCase().replace(/ё/g, "е");
      if (normalizedResponse.includes(normalizedTitle)) return true;
      const sourceWords = new Set(
        normalizeWords(`${source.title} ${source.excerpt}`),
      );
      let overlap = 0;
      for (const word of responseWords) {
        if (sourceWords.has(word)) overlap += 1;
      }
      return overlap >= 2;
    })
    .slice(0, 6);
}
