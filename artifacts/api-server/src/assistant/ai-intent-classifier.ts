import { ai } from "@workspace/integrations-gemini-ai";
import {
  assistantIntentSchema,
  type AssistantIntent,
} from "./assistant-intent.js";
import { getCurrentMoscowDateTimeForModel } from "../lib/time.js";

export type IntentClassificationResult =
  | { status: "valid"; value: AssistantIntent }
  | { status: "invalid"; reason: string }
  | { status: "unavailable"; reason: string };

type ClassifyAssistantIntentParams = {
  message: string;
  folderNames: string[];
  model: string;
  context?: string;
};

export function buildClassifierPrompt(
  message: string,
  folderNames: string[],
  context = "",
) {
  const now = getCurrentMoscowDateTimeForModel();
  const folders = folderNames.length > 0 ? folderNames.join(", ") : "нет папок";

  return `Ты — модуль понимания естественного языка MindVault.
Верни только один валидный JSON-объект без markdown и пояснений.

Текущее московское время: ${now}.
Папки пользователя: ${folders}.
${context}

Допустимые intent:
create_note, create_list, create_reminder, update_note, update_list,
update_reminder, delete_item, move_item_to_folder, search_items,
answer_from_sources, create_folder, rename_folder, chat_general, clarify, cancel.

Обязательные поля:
- intent: одна строка из списка;
- data: объект согласно intent;
- memory: необязательный объект {"facts":[...]}.

Принципы:
- Понимай разговорный русский, опечатки, ссылки на недавний контекст и привычные названия.
- Выбирай наиболее логичное действие по смыслу и персональному контексту.
- Не проси подтверждение обратимого действия: backend выполнит его и предложит отмену.
- clarify используй только при бессмыслице, взаимоисключающих указаниях или объективной невозможности определить цель. Верни один короткий вопрос, без кнопок.
- Обычный вопрос, совет, обсуждение или фраза о планах без просьбы изменить MindVault — chat_general.
- Вопрос по сохранённым данным — answer_from_sources.
- "сохрани идею", "запиши мысль", "зафиксируй" — create_note.
- Фразы "мне нужно", "надо", "планирую" сами по себе не создают напоминание.
- Напоминание создавай при явной просьбе напомнить или поставить напоминание. Время по умолчанию 09:00.
- Для отметки пункта списка выполненным используй completeItems, а не removeItems.
- Если несколько объектов похожи, используй недавний контекст и точные совпадения. Уточняй только когда варианты действительно равноценны.
- Не утверждай, что действие уже выполнено: ты только формируешь команду.

Формы data:
- create_note: {"title": string, "content": string, "folderName": string|null}
- create_list: {"title": string, "items": string[], "folderName": string|null}
- create_reminder: {"title": string, "content": string, "date": "YYYY-MM-DD", "time": "HH:mm", "folderName": string|null}
- update_note: {"targetQuery": string, "title"?: string, "content"?: string}
- update_list: {"targetQuery": string, "title"?: string, "addItems"?: string[], "removeItems"?: string[], "completeItems"?: string[], "reopenItems"?: string[]}
- update_reminder: {"targetQuery": string, "title"?: string, "content"?: string, "date"?: "YYYY-MM-DD", "time"?: "HH:mm"}
- search_items: {"query": string, "types"?: ("note"|"list"|"reminder"|"file"|"folder")[]}
- answer_from_sources: {"query": string, "types"?: ("note"|"list"|"reminder"|"file"|"folder")[]}
- move_item_to_folder: {"itemQuery": string, "itemType"?: "note"|"list"|"reminder"|"file", "folderName": string}
- create_folder: {"name": string}
- rename_folder: {"folderName": string, "newName": string}
- delete_item: {"itemQuery": string, "itemType"?: "note"|"list"|"reminder"|"file"|"folder"}
- chat_general: {}
- cancel: {}
- clarify: {"question": string}

Память:
- Добавляй memory.facts только для явно устойчивых сведений: "запомни", "обычно", "всегда", "предпочитаю", "я называю", устойчивый проект или правило.
- Не сохраняй разовую задачу, случайную реплику или содержание обычного вопроса.
- fact: {"category":"person"|"alias"|"slang"|"preference"|"project"|"habit","key":string,"value":string}

Сообщение пользователя:
${JSON.stringify(message)}`;
}

export function parseAssistantIntentResponse(text: string): IntentClassificationResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { status: "invalid", reason: "empty_response" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { status: "invalid", reason: "invalid_json" };
  }

  const validation = assistantIntentSchema.safeParse(parsed);
  if (!validation.success) {
    return {
      status: "invalid",
      reason: validation.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    };
  }
  return { status: "valid", value: validation.data };
}

export async function classifyAssistantIntent({
  message,
  folderNames,
  model,
  context,
}: ClassifyAssistantIntentParams): Promise<IntentClassificationResult> {
  try {
    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [{ text: buildClassifierPrompt(message, folderNames, context) }],
        },
      ],
      config: { responseMimeType: "application/json" },
    });
    return parseAssistantIntentResponse(response.text ?? "");
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : "provider_unavailable",
    };
  }
}
