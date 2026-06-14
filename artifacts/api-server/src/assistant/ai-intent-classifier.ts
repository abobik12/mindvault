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
};

function buildClassifierPrompt(message: string, folderNames: string[]) {
  const now = getCurrentMoscowDateTimeForModel();
  const folders = folderNames.length > 0 ? folderNames.join(", ") : "нет папок";

  return `Ты классификатор команд для MindVault. Верни только один JSON-объект без markdown.

Текущее московское время: ${now}.
Папки пользователя: ${folders}.

Разрешенные intent:
create_note, create_list, create_reminder, search_items, move_item_to_folder,
create_folder, rename_folder, delete_item, chat_general, clarify.

Общие обязательные поля:
- intent: одна из строк выше;
- confidence: число от 0 до 1;
- needsConfirmation: boolean;
- data: объект согласно intent.

Правила:
- Не придумывай отсутствующие имена, содержимое, папки или объекты.
- Обычный разговор, вопрос, совет или обсуждение без просьбы изменить MindVault — chat_general.
- "Сохрани идею", "запиши мысль", "зафиксируй" — create_note.
- Для списка верни непустой массив items.
- Для напоминания верни date в YYYY-MM-DD и time в HH:mm. Если время не указано, используй 09:00.
- Если год не указан, выбери ближайшую будущую дату относительно текущего московского времени.
- Удаление, перемещение и переименование всегда имеют needsConfirmation=true.
- Если команда двусмысленна, данных недостаточно или уверенность ниже 0.82 — intent=clarify и задай короткий вопрос в data.question.
- Не утверждай, что действие выполнено: ты только классифицируешь.

Формы data:
- create_note: {"title": string, "content": string, "folderName": string|null}
- create_list: {"title": string, "items": string[], "folderName": string|null}
- create_reminder: {"title": string, "content": string, "date": string, "time": string, "folderName": string|null}
- search_items: {"query": string, "types"?: ("note"|"list"|"reminder"|"file"|"folder")[]}
- move_item_to_folder: {"itemQuery": string, "itemType"?: "note"|"list"|"reminder"|"file", "folderName": string}
- create_folder: {"name": string}
- rename_folder: {"folderName": string, "newName": string}
- delete_item: {"itemQuery": string, "itemType"?: "note"|"list"|"reminder"|"file"|"folder"}
- chat_general: {}
- clarify: {"question": string}

Примеры:
Сообщение: "сохрани идею: добавить раздел про ИИ"
Ответ: {"intent":"create_note","confidence":0.99,"needsConfirmation":false,"data":{"title":"Добавить раздел про ИИ","content":"Добавить раздел про ИИ","folderName":null}}

Сообщение: "запиши мысль о новой структуре диплома"
Ответ: {"intent":"create_note","confidence":0.96,"needsConfirmation":false,"data":{"title":"Новая структура диплома","content":"Мысль о новой структуре диплома","folderName":null}}

Сообщение: "как лучше подготовиться к защите диплома?"
Ответ: {"intent":"chat_general","confidence":0.99,"needsConfirmation":false,"data":{}}

Сообщение пользователя:
${JSON.stringify(message)}`;
}

export async function classifyAssistantIntent({
  message,
  folderNames,
  model,
}: ClassifyAssistantIntentParams): Promise<IntentClassificationResult> {
  let response;
  try {
    response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [{ text: buildClassifierPrompt(message, folderNames) }],
        },
      ],
      config: {
        responseMimeType: "application/json",
      },
    });
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : "AI provider unavailable",
    };
  }

  const text = response.text?.trim();
  if (!text) {
    return { status: "invalid", reason: "Classifier returned an empty response" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "invalid", reason: "Classifier returned invalid JSON" };
  }

  const validation = assistantIntentSchema.safeParse(parsed);
  if (!validation.success) {
    const receivedIntent =
      parsed &&
      typeof parsed === "object" &&
      "intent" in parsed &&
      typeof parsed.intent === "string"
        ? ` Получен intent: ${parsed.intent}.`
        : "";
    return {
      status: "invalid",
      reason:
        validation.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ") + receivedIntent,
    };
  }

  return { status: "valid", value: validation.data };
}
