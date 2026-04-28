type CompatibleContentPart = {
  text?: string | null;
};

type CompatibleMessage = {
  role: "user" | "model";
  parts: CompatibleContentPart[];
};

type GenerateContentInput = {
  model?: string;
  contents: CompatibleMessage[];
  config?: {
    responseMimeType?: string;
    maxOutputTokens?: number;
  };
};

type GenerateContentOutput = {
  text: string;
};

type StreamChunk = {
  text: string;
};

type Provider = "openai" | "openrouter";

type ProviderConfig = {
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  model: string;
  headers: Record<string, string>;
};

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";

function assertAscii(value: string, variableName: string): void {
  if (!/^[\x00-\x7F]*$/.test(value)) {
    throw new Error(`${variableName} должен содержать только ASCII-символы.`);
  }
}

function looksLikeOpenRouterKey(value: string): boolean {
  return value.startsWith("sk-or-");
}

function trimEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function resolveProviderConfig(): ProviderConfig {
  const openRouterApiKey = trimEnv("OPENROUTER_API_KEY");
  const openAiApiKey = trimEnv("OPENAI_API_KEY");

  if (!openRouterApiKey && !openAiApiKey) {
    throw new Error(
      "Не задан ключ AI. Укажите OPENROUTER_API_KEY или OPENAI_API_KEY в переменных окружения.",
    );
  }

  const shouldUseOpenRouter =
    Boolean(openRouterApiKey) ||
    (Boolean(openAiApiKey) && looksLikeOpenRouterKey(openAiApiKey as string));

  if (shouldUseOpenRouter) {
    const apiKey = openRouterApiKey || (openAiApiKey as string);
    assertAscii(apiKey, openRouterApiKey ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY");

    const baseUrl = (
      trimEnv("OPENROUTER_BASE_URL") ||
      trimEnv("OPENAI_BASE_URL") ||
      DEFAULT_OPENROUTER_BASE_URL
    ).replace(/\/+$/, "");

    const model =
      trimEnv("OPENROUTER_MODEL") ||
      trimEnv("OPENAI_MODEL") ||
      DEFAULT_OPENROUTER_MODEL;

    const referer = trimEnv("OPENROUTER_SITE_URL") || "http://localhost:18174";
    const appName = trimEnv("OPENROUTER_APP_NAME") || "MindVault";

    return {
      provider: "openrouter",
      apiKey,
      baseUrl,
      model,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": appName,
      },
    };
  }

  const apiKey = openAiApiKey as string;
  assertAscii(apiKey, "OPENAI_API_KEY");

  const baseUrl = (trimEnv("OPENAI_BASE_URL") || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  const model = trimEnv("OPENAI_MODEL") || DEFAULT_OPENAI_MODEL;

  return {
    provider: "openai",
    apiKey,
    baseUrl,
    model,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  };
}

function normalizeModel(requestedModel: string | undefined, defaultModel: string): string {
  if (!requestedModel) return defaultModel;

  if (requestedModel.startsWith("gemini-")) {
    return defaultModel;
  }

  return requestedModel;
}

function getTextFromParts(parts: CompatibleContentPart[]): string {
  return parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function toOpenAiMessages(contents: CompatibleMessage[]) {
  return contents.map((message, index) => {
    const text = getTextFromParts(message.parts);

    if (index === 0 && message.role === "user") {
      return { role: "system" as const, content: text };
    }

    return {
      role: message.role === "model" ? ("assistant" as const) : ("user" as const),
      content: text,
    };
  });
}

function extractTextFromCompletionContent(content: unknown): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const textValue = (part as { text?: unknown }).text;
          return typeof textValue === "string" ? textValue : "";
        }
        return "";
      })
      .join("");
  }

  return "";
}

async function readErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

function providerLabel(provider: Provider): string {
  return provider === "openrouter" ? "OpenRouter" : "OpenAI";
}

async function callOpenAiCompletion(input: GenerateContentInput): Promise<GenerateContentOutput> {
  const config = resolveProviderConfig();
  const model = normalizeModel(input.model, config.model);

  const body: Record<string, unknown> = {
    model,
    messages: toOpenAiMessages(input.contents),
  };

  if (typeof input.config?.maxOutputTokens === "number") {
    body.max_tokens = input.config.maxOutputTokens;
  }

  if (input.config?.responseMimeType === "application/json") {
    body.response_format = { type: "json_object" };
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: config.headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await readErrorText(response);
    throw new Error(`${providerLabel(config.provider)} completion error: ${errText}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: unknown;
      };
    }>;
  };

  const content = data.choices?.[0]?.message?.content;
  return { text: extractTextFromCompletionContent(content) };
}

async function* callOpenAiCompletionStream(input: GenerateContentInput): AsyncGenerator<StreamChunk> {
  const config = resolveProviderConfig();
  const model = normalizeModel(input.model, config.model);

  const body: Record<string, unknown> = {
    model,
    messages: toOpenAiMessages(input.contents),
    stream: true,
  };

  if (typeof input.config?.maxOutputTokens === "number") {
    body.max_tokens = input.config.maxOutputTokens;
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: config.headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await readErrorText(response);
    throw new Error(`${providerLabel(config.provider)} stream error: ${errText}`);
  }

  if (!response.body) {
    throw new Error(`${providerLabel(config.provider)} вернул пустой поток.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const event of events) {
      const lines = event.split("\n");
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();

        if (!payload || payload === "[DONE]") continue;

        let parsed: any;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        const chunkContent = parsed?.choices?.[0]?.delta?.content;
        if (typeof chunkContent === "string" && chunkContent.length > 0) {
          yield { text: chunkContent };
          continue;
        }

        if (Array.isArray(chunkContent)) {
          for (const part of chunkContent) {
            const text = part && typeof part === "object" ? (part.text as string | undefined) : undefined;
            if (typeof text === "string" && text.length > 0) {
              yield { text };
            }
          }
        }
      }
    }
  }
}

export const ai = {
  models: {
    generateContent: callOpenAiCompletion,
    generateContentStream: callOpenAiCompletionStream,
  },
};
