import { createRequire } from "node:module";

const requireOptional = createRequire(import.meta.url);

const EXTRACTED_TEXT_MAX_CHARS = 300_000;
const TEXT_FILE_EXTENSIONS = new Set(["txt", "md", "csv", "json", "xml", "yml", "yaml", "log", "html", "css", "js", "ts"]);
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "text/csv",
]);

export type FileExtractionStatus = "completed" | "unsupported" | "failed";

export type FileExtractionResult = {
  text: string | null;
  summary: string;
  status: FileExtractionStatus;
};

function getFileExtension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

function isPlainTextUpload(filename: string, mimeType: string): boolean {
  const normalizedMime = mimeType.toLowerCase();
  const extension = getFileExtension(filename);
  return normalizedMime.startsWith("text/") || TEXT_MIME_TYPES.has(normalizedMime) || TEXT_FILE_EXTENSIONS.has(extension);
}

function isPdfUpload(filename: string, mimeType: string): boolean {
  return mimeType.toLowerCase().includes("pdf") || getFileExtension(filename) === "pdf";
}

function isDocxUpload(filename: string, mimeType: string): boolean {
  const normalizedMime = mimeType.toLowerCase();
  return (
    getFileExtension(filename) === "docx" ||
    normalizedMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
}

export function canAttemptTextExtraction(filename: string, mimeType: string | null | undefined): boolean {
  const normalizedMime = mimeType ?? "";
  return isPlainTextUpload(filename, normalizedMime) || isPdfUpload(filename, normalizedMime) || isDocxUpload(filename, normalizedMime);
}

function cleanExtractedText(value: string | null | undefined): string | null {
  const cleaned = (value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();

  if (!cleaned) return null;
  return cleaned.slice(0, EXTRACTED_TEXT_MAX_CHARS);
}

function validateTextLike(value: string): string | null {
  const cleaned = cleanExtractedText(value);
  if (!cleaned) return null;

  const controlChars = cleaned.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g)?.length ?? 0;
  const replacementChars = cleaned.match(/\uFFFD/g)?.length ?? 0;
  if (controlChars / cleaned.length > 0.02 || replacementChars / cleaned.length > 0.01) {
    return null;
  }

  return cleaned;
}

function extractionSummary(status: FileExtractionStatus, detail?: string): string {
  const prefix = `extractionStatus:${status}`;
  return detail ? `${prefix}; ${detail}` : prefix;
}

function loadPdfParser(): (input: Buffer) => Promise<{ text?: string }> {
  const parser = requireOptional("pdf-parse/lib/pdf-parse.js");
  const pdfParse = (parser as { default?: unknown }).default ?? parser;
  if (typeof pdfParse !== "function") {
    throw new Error("pdf parser is not available");
  }
  return pdfParse as (input: Buffer) => Promise<{ text?: string }>;
}

function loadMammoth(): { extractRawText(input: { buffer: Buffer }): Promise<{ value?: string }> } {
  const imported = requireOptional("mammoth");
  const mammoth = (imported as { default?: unknown }).default ?? imported;
  if (!mammoth || typeof (mammoth as { extractRawText?: unknown }).extractRawText !== "function") {
    throw new Error("docx parser is not available");
  }
  return mammoth as { extractRawText(input: { buffer: Buffer }): Promise<{ value?: string }> };
}

export async function extractTextFromUpload(filename: string, mimeType: string, fileData: string): Promise<FileExtractionResult> {
  const buffer = Buffer.from(fileData, "base64");

  try {
    if (isPlainTextUpload(filename, mimeType)) {
      const text = validateTextLike(buffer.toString("utf8"));
      return text
        ? { text, status: "completed", summary: extractionSummary("completed", "plain text extracted") }
        : { text: null, status: "failed", summary: extractionSummary("failed", "plain text could not be decoded safely") };
    }

    if (isPdfUpload(filename, mimeType)) {
      const parsed = await loadPdfParser()(buffer);
      const text = cleanExtractedText(parsed.text);
      return text
        ? { text, status: "completed", summary: extractionSummary("completed", "pdf text extracted") }
        : { text: null, status: "failed", summary: extractionSummary("failed", "pdf parser returned no text") };
    }

    if (isDocxUpload(filename, mimeType)) {
      const parsed = await loadMammoth().extractRawText({ buffer });
      const text = cleanExtractedText(parsed.value);
      return text
        ? { text, status: "completed", summary: extractionSummary("completed", "docx text extracted") }
        : { text: null, status: "failed", summary: extractionSummary("failed", "docx parser returned no text") };
    }

    return { text: null, status: "unsupported", summary: extractionSummary("unsupported", "format is metadata-only") };
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 180) : "unknown extraction error";
    return { text: null, status: "failed", summary: extractionSummary("failed", message) };
  }
}
