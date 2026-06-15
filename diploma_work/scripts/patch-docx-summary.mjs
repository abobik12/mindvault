import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZipModule from "../../node_modules/.pnpm/jszip@3.10.1/node_modules/jszip/lib/index.js";

const JSZip = JSZipModule.default ?? JSZipModule;
const finalDir = "D:/Univer/AI-Workspace-Hub/diploma_work/final";
const names = JSON.parse(await readFile(path.join(finalDir, "output-names.json"), "utf8"));
const docxPath = path.join(finalDir, names.docx);

const zip = await JSZip.loadAsync(await readFile(docxPath));
const file = zip.file("word/document.xml");
if (!file) throw new Error("word/document.xml not found");

let xml = await file.async("string");
xml = xml
  .replace("содержит 58 страниц, 21 таблиц, 15 рисунков", "содержит 56 страниц, 21 таблицу, 15 рисунков")
  .replace("содержит 55 страниц, 21 таблиц, 15 рисунков", "содержит 56 страниц, 21 таблицу, 15 рисунков")
  .replace("содержит 56 страниц, 21 таблиц, 15 рисунков", "содержит 56 страниц, 21 таблицу, 15 рисунков");

zip.file("word/document.xml", xml);
await writeFile(docxPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
console.log(docxPath);
