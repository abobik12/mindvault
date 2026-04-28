import { ai } from "../client";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-1";

export async function generateImage(
  prompt: string
): Promise<{ b64_json: string; mimeType: string }> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY не задан. Генерация изображения недоступна.");
  }

  const baseUrl = (process.env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  const imageModel = process.env.OPENAI_IMAGE_MODEL?.trim() || DEFAULT_OPENAI_IMAGE_MODEL;

  const response = await fetch(`${baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: imageModel,
      prompt,
      response_format: "b64_json",
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI image generation error: ${err || response.status}`);
  }

  const data = (await response.json()) as {
    data?: Array<{
      b64_json?: string;
    }>;
  };

  const imageBase64 = data.data?.[0]?.b64_json;

  if (!imageBase64) {
    throw new Error("OpenAI не вернул данные изображения.");
  }

  return {
    b64_json: imageBase64,
    mimeType: "image/png",
  };
}

export { ai };
