import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve("diploma_work");
const outDir = path.join(root, "extracted");
await fs.mkdir(outDir, { recursive: true });

const require = createRequire(import.meta.url);
const mammoth = require("../../node_modules/.pnpm/mammoth@1.12.0/node_modules/mammoth");
const pdfParse = require("../../node_modules/.pnpm/pdf-parse@1.1.4/node_modules/pdf-parse/lib/pdf-parse.js");

const files = await fs.readdir(root);

function safeName(name) {
  return name.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_");
}

for (const file of files) {
  const fullPath = path.join(root, file);
  const stat = await fs.stat(fullPath);
  if (!stat.isFile()) continue;

  const ext = path.extname(file).toLowerCase();
  let text = "";

  try {
    if (ext === ".docx") {
      const result = await mammoth.extractRawText({ path: fullPath });
      text = result.value || "";
    } else if (ext === ".pdf") {
      const data = await fs.readFile(fullPath);
      const result = await pdfParse(data);
      text = result.text || "";
    } else {
      continue;
    }
  } catch (error) {
    text = `EXTRACTION_FAILED: ${error instanceof Error ? error.stack : String(error)}`;
  }

  const output = [
    `SOURCE: ${file}`,
    `SIZE_BYTES: ${stat.size}`,
    `EXTRACTED_CHARS: ${text.length}`,
    "",
    text.replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim(),
    "",
  ].join("\n");

  await fs.writeFile(path.join(outDir, `${safeName(file)}.txt`), output, "utf8");
  console.log(`${file}\t${text.length}`);
}
