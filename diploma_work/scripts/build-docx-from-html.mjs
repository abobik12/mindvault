import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import JSZipModule from "../../node_modules/.pnpm/jszip@3.10.1/node_modules/jszip/lib/index.js";

const JSZip = JSZipModule.default ?? JSZipModule;
const root = "D:/Univer/AI-Workspace-Hub/diploma_work";
const finalDir = path.join(root, "final");
const preferredHtmlPath = path.join(finalDir, "diploma_pdf.html");
let htmlPath = preferredHtmlPath;
try {
  await readFile(preferredHtmlPath);
} catch {
  htmlPath = path.join(finalDir, "diploma.html");
}
const names = JSON.parse(await readFile(path.join(finalDir, "output-names.json"), "utf8"));
const docxPath = path.join(finalDir, names.docx);

function x(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeHtml(value) {
  return String(value ?? "")
    .replaceAll(/<br\s*\/?>/gi, "\n")
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll(/\s+\n/g, "\n")
    .replaceAll(/\n\s+/g, "\n")
    .trim();
}

function cmToEmu(cm) {
  return Math.round(cm * 360000);
}

function twipsCm(cm) {
  return Math.round(cm * 567);
}

function runText(text, opts = {}) {
  const parts = String(text).split("\n");
  return parts
    .map((part, index) => {
      const br = index === 0 ? "" : "<w:br/>";
      const props = opts.bold ? "<w:rPr><w:b/></w:rPr>" : "";
      return `<w:r>${props}${br}<w:t xml:space="preserve">${x(part)}</w:t></w:r>`;
    })
    .join("");
}

function paragraph(text, opts = {}) {
  const jc = opts.align ? `<w:jc w:val="${opts.align}"/>` : "";
  const indent = opts.noIndent ? "" : '<w:ind w:firstLine="708"/>';
  const style = opts.style ? `<w:pStyle w:val="${opts.style}"/>` : "";
  const spacing = '<w:spacing w:line="360" w:lineRule="auto" w:after="120"/>';
  const pageBreak = opts.pageBreakBefore ? "<w:pageBreakBefore/>" : "";
  const rPr = [];
  if (opts.fontSize) rPr.push(`<w:sz w:val="${Math.round(opts.fontSize * 2)}"/>`);
  if (opts.bold) rPr.push("<w:b/>");
  const rPrXml = rPr.length ? `<w:rPr>${rPr.join("")}</w:rPr>` : "";
  return `<w:p><w:pPr>${style}${pageBreak}${jc}${indent}${spacing}</w:pPr><w:r>${rPrXml}<w:t></w:t></w:r>${runText(text, { bold: opts.boldRun })}</w:p>`;
}

function tocField() {
  return `<w:p><w:pPr><w:spacing w:line="360" w:lineRule="auto" w:after="120"/></w:pPr>
<w:r><w:fldChar w:fldCharType="begin"/></w:r>
<w:r><w:instrText xml:space="preserve">TOC \\o "1-3" \\h \\z \\u</w:instrText></w:r>
<w:r><w:fldChar w:fldCharType="separate"/></w:r>
<w:r><w:t>Оглавление будет обновлено при экспорте.</w:t></w:r>
<w:r><w:fldChar w:fldCharType="end"/></w:r>
</w:p>`;
}

function tableXml(rows, opts = {}) {
  const width = 9638;
  const fontSize = opts.small ? 21 : 22;
  const trXml = rows
    .map((row) => `<w:tr>${row
      .map((cell, index) => {
        const bold = opts.header && row === rows[0] ? "<w:b/>" : "";
        const shade = opts.header && row === rows[0] ? '<w:shd w:fill="F1F5F9"/>' : "";
        return `<w:tc><w:tcPr><w:tcW w:w="${Math.floor(width / row.length)}" w:type="dxa"/>${shade}</w:tcPr><w:p><w:pPr><w:spacing w:line="276" w:lineRule="auto" w:after="60"/><w:jc w:val="${opts.header && row === rows[0] ? "center" : "both"}"/></w:pPr><w:r><w:rPr>${bold}<w:sz w:val="${fontSize}"/></w:rPr><w:t xml:space="preserve">${x(decodeHtml(cell))}</w:t></w:r></w:p></w:tc>`;
      })
      .join("")}</w:tr>`)
    .join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="${width}" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="6" w:space="0" w:color="000000"/><w:left w:val="single" w:sz="6" w:space="0" w:color="000000"/><w:bottom w:val="single" w:sz="6" w:space="0" w:color="000000"/><w:right w:val="single" w:sz="6" w:space="0" w:color="000000"/><w:insideH w:val="single" w:sz="6" w:space="0" w:color="000000"/><w:insideV w:val="single" w:sz="6" w:space="0" w:color="000000"/></w:tblBorders></w:tblPr>${trXml}</w:tbl>`;
}

function parseRows(tableHtml) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(tableHtml))) {
    const cells = [];
    const cellRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
    let cell;
    while ((cell = cellRe.exec(tr[1]))) cells.push(cell[1]);
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function pngSize(buffer) {
  if (buffer.toString("ascii", 1, 4) !== "PNG") return { width: 1280, height: 800 };
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function svgSize(text) {
  const width = Number(/width="([\d.]+)"/.exec(text)?.[1] ?? 1180);
  const height = Number(/height="([\d.]+)"/.exec(text)?.[1] ?? 680);
  return { width, height };
}

function drawingXml(relId, name, widthCm, heightCm) {
  const cx = cmToEmu(widthCm);
  const cy = cmToEmu(heightCm);
  return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="60"/></w:pPr><w:r><w:drawing>
<wp:inline distT="0" distB="0" distL="0" distR="0">
<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${relId.replace(/\D/g, "")}" name="${x(name)}"/><wp:cNvGraphicFramePr/>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="${x(name)}"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function diagramBlock(fileName) {
  const diagrams = {
    "01-architecture.svg": [
      ["Пользователь\nбраузер desktop/mobile", "→ HTTP", "Frontend\nReact + Vite + TypeScript", "→ REST API", "Backend\nNode.js + Express"],
      ["Файлы\nbase64 и извлечение текста", "→", "PostgreSQL\nDrizzle ORM", "↔", "ИИ-провайдер\nOpenAI-compatible API"],
    ],
    "02-deployment.svg": [
      ["Браузер пользователя", "→", "Контейнер web\nпорт 18174", "→", "Контейнер api\nпорт 8080"],
      ["", "", "Контейнер db\nPostgreSQL 16 + volume", "↔", "Внешний API\nLLM provider"],
    ],
    "03-database.svg": [
      ["users\nid, email, passwordHash", "1:N", "folders\nuserId, name, isSystem", "1:N", "items\ntype, title, content"],
      ["users", "1:N", "conversations\ntitle, createdAt", "1:N", "messages\nrole, content, metadata"],
    ],
    "04-timeline.svg": [
      ["1. Открытие приложения", "2. Загрузка сущностей", "3. Отправка сообщения", "4. Запрос на backend"],
      ["5. Определение намерения", "6. Действие в БД", "7. Ответ ассистента", "8. Обновление UI"],
    ],
    "05-intent.svg": [
      ["Сообщение пользователя", "Есть явная команда?", "Да: создать объект после записи в БД"],
      ["Нет: обычный вопрос", "Спорно: предложить выбор", "Подтверждение только после success"],
    ],
    "06-ui.svg": [
      ["Sidebar\nнавигация, папки, профиль", "Верхняя область\nзаголовок, фильтры, действия"],
      ["Рабочая область\nчат или карточки объектов", "Нижняя панель чата\nввод, вложения, отправка"],
    ],
  };
  const rows = diagrams[fileName] ?? [[fileName]];
  const prepared = rows.map((row) => row.map((cell) => String(cell).replaceAll("\n", " / ")));
  return tableXml(prepared, { header: false, small: true });
}

const html = await readFile(htmlPath, "utf8");
const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
const tokenRe = /<div class="page-break"><\/div>|<div class="figure">[\s\S]*?<\/div>|<h[123][^>]*>[\s\S]*?<\/h[123]>|<p(?: class="([^"]*)")?[^>]*>[\s\S]*?<\/p>|<ul>[\s\S]*?<\/ul>|<table[\s\S]*?<\/table>/gi;

const zip = new JSZip();
const rels = [
  ['rIdStyles', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles', 'styles.xml'],
  ['rIdSettings', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings', 'settings.xml'],
  ['rIdFooterFirst', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer', 'footer1.xml'],
  ['rIdFooterDefault', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer', 'footer2.xml'],
];
const contentDefaults = new Map([
  ["rels", "application/vnd.openxmlformats-package.relationships+xml"],
  ["xml", "application/xml"],
  ["png", "image/png"],
  ["svg", "image/svg+xml"],
]);
const parts = [];
let imageIndex = 0;

let match;
while ((match = tokenRe.exec(body))) {
  const token = match[0];
  if (token.startsWith('<div class="page-break"')) {
    parts.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    continue;
  }
  if (/^<h1/i.test(token)) {
    parts.push(paragraph(decodeHtml(token), { style: "Heading1", align: "center", noIndent: true }));
    continue;
  }
  if (/^<h2/i.test(token)) {
    parts.push(paragraph(decodeHtml(token), { style: "Heading2", noIndent: true }));
    continue;
  }
  if (/^<h3/i.test(token)) {
    parts.push(paragraph(decodeHtml(token), { style: "Heading3", noIndent: true }));
    continue;
  }
  if (/^<p/i.test(token)) {
    const cls = /class="([^"]+)"/.exec(token)?.[1] ?? "";
    const value = decodeHtml(token);
    if (value === "__TOC__") {
      parts.push(tocField());
    } else {
      parts.push(paragraph(value, {
        align: cls.includes("center") || cls.includes("fig-title") ? "center" : cls.includes("right") ? "right" : "both",
        noIndent: cls.includes("no-indent") || cls.includes("center") || cls.includes("fig-title") || cls.includes("table-title") || cls.includes("title-theme"),
        boldRun: cls.includes("title-theme"),
      }));
    }
    continue;
  }
  if (/^<ul/i.test(token)) {
    const items = [...token.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => decodeHtml(m[1]));
    for (const item of items) parts.push(paragraph(`- ${item}`, { noIndent: false }));
    continue;
  }
  if (/^<table/i.test(token)) {
    const rows = parseRows(token);
    if (rows.length) parts.push(tableXml(rows, { header: !token.includes('class="abbr"'), small: true }));
    continue;
  }
  if (/^<div class="figure"/i.test(token)) {
    const img = /<img[^>]+src="([^"]+)"[^>]*>/i.exec(token);
    if (!img) continue;
    let imgPath = decodeURIComponent(img[1].replace(/^file:\/\/\//, ""));
    if (/^[A-Za-z]:\//.test(imgPath)) imgPath = imgPath.replaceAll("/", "\\");
    const absolute = imgPath.replaceAll("\\", "/");
    const ext = path.extname(absolute).slice(1).toLowerCase();
    if (ext === "svg") {
      parts.push(diagramBlock(path.basename(absolute)));
      continue;
    }
    const buffer = await readFile(absolute);
    imageIndex += 1;
    const mediaName = `image${imageIndex}.${ext}`;
    zip.file(`word/media/${mediaName}`, buffer);
    const relId = `rIdImage${imageIndex}`;
    rels.push([relId, `http://schemas.openxmlformats.org/officeDocument/2006/relationships/image`, `media/${mediaName}`]);
    let size = ext === "png" ? pngSize(buffer) : svgSize(buffer.toString("utf8"));
    const styleWidth = /style="[^"]*width:([\d.]+)cm/i.exec(token);
    const widthCm = styleWidth ? Number(styleWidth[1]) : 16.5;
    const heightCm = Math.min(22, widthCm * (size.height / size.width));
    parts.push(drawingXml(relId, mediaName, widthCm, heightCm));
  }
}

const sectPr = `<w:sectPr><w:footerReference w:type="first" r:id="rIdFooterFirst"/><w:footerReference w:type="default" r:id="rIdFooterDefault"/><w:titlePg/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${twipsCm(2)}" w:right="${twipsCm(1)}" w:bottom="${twipsCm(2)}" w:left="${twipsCm(3)}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;
const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>${parts.join("\n")}${sectPr}</w:body></w:document>`;

zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${[...contentDefaults].map(([ext, type]) => `<Default Extension="${ext}" ContentType="${type}"/>`).join("")}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/word/footer2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`);
zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join("")}</Relationships>`);
zip.file("word/document.xml", documentXml);
zip.file("word/settings.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:updateFields w:val="true"/></w:settings>`);
zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="28"/></w:rPr><w:pPr><w:spacing w:line="360" w:lineRule="auto" w:after="120"/><w:ind w:firstLine="708"/><w:jc w:val="both"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:pageBreakBefore/><w:spacing w:after="360"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="240" w:after="160"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="200" w:after="120"/></w:pPr><w:rPr><w:b/><w:i/><w:sz w:val="28"/></w:rPr></w:style></w:styles>`);
zip.file("word/footer1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p/></w:ftr>`);
zip.file("word/footer2.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`);

await mkdir(finalDir, { recursive: true });
await writeFile(docxPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
console.log(JSON.stringify({ docxPath, images: imageIndex }, null, 2));
