import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = "D:/Univer/AI-Workspace-Hub/diploma_work";
const finalDir = path.join(root, "final");
const input = path.join(finalDir, "diploma.html");
const output = path.join(finalDir, "diploma_pdf.html");
const counts = JSON.parse(await readFile(path.join(finalDir, "counts.json"), "utf8"));
const pageCount = process.argv[2] ?? "__PAGE_COUNT__";
const tableWord = counts.tables % 10 === 1 && counts.tables % 100 !== 11 ? "таблицу" : "таблиц";

function decode(value) {
  return String(value)
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .trim();
}

let html = await readFile(input, "utf8");
const headings = [];
for (const match of html.matchAll(/<(h[12])>([\s\S]*?)<\/\1>/gi)) {
  const text = decode(match[2]);
  if (text === "Оглавление") continue;
  headings.push({ level: match[1] === "h1" ? 1 : 2, text });
}

const toc = [
  '<div class="manual-toc">',
  ...headings.map((heading) => `<p class="toc-l${heading.level}">${heading.text}</p>`),
  '</div>',
].join("\n");

html = html
  .replaceAll("__PAGE_COUNT__", String(pageCount))
  .replaceAll("__TABLE_COUNT__ таблиц", `${counts.tables} ${tableWord}`)
  .replaceAll("__TABLE_COUNT__", String(counts.tables))
  .replaceAll(`${counts.tables} таблиц`, `${counts.tables} ${tableWord}`)
  .replaceAll("__FIGURE_COUNT__", String(counts.figures))
  .replaceAll("__SOURCE_COUNT__", String(counts.sources))
  .replace(/<p[^>]*>__TOC__<\/p>/, toc)
  .replace("</style>", `.manual-toc p { text-indent: 0; text-align: left; margin: 0 0 2pt 0; }
.toc-l1 { font-weight: bold; }
.toc-l2 { margin-left: 16pt !important; font-size: 13pt; }
</style>`);

await writeFile(output, html, "utf8");
console.log(output);
