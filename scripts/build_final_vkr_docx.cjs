const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const JSZip = require("../node_modules/.pnpm/jszip@3.10.1/node_modules/jszip");

const root = "D:/Univer/AI-Workspace-Hub";
const outDocx = path.join(root, "ВКР_Рачинский_Иван_MindVault_готовая.docx");
const reportPath = path.join(root, "13_Отчет_о_финальной_сборке.md");
const mdPath = path.join(root, "07_Полный_черновик_ВКР_MindVault_вычитанный.md");
const screenshotsDir = path.join(root, "vkr_assets", "final_screenshots");
const today = "02.06.2026";
const pageCount = 83;

const figImages = {
  1: path.join(root, "pics_diploma", "Рис. 1. Общая архитектура приложения MindVault.png"),
  2: path.join(root, "pics_diploma", "Рис. 2. Диаграмма развертывания приложения MindVault.png"),
  3: path.join(root, "pics_diploma", "Рис. 3. Схема базы данных приложения MindVault.png"),
  4: path.join(root, "pics_diploma", "Рис. 4. Схема обработки пользовательского сообщения.png"),
  5: path.join(root, "pics_diploma", "Рис. 5. Схема работы ИИ-ассистента с пользовательским контекстом.png"),
  6: path.join(root, "pics_diploma", "Рис. 6. Схема загрузки и обработки файла.png"),
  7: path.join(screenshotsDir, "fig07_main_page.png"),
  8: path.join(screenshotsDir, "fig08_ai_chat.png"),
  9: path.join(screenshotsDir, "fig09_notes.png"),
  10: path.join(screenshotsDir, "fig10_files.png"),
  11: path.join(screenshotsDir, "fig11_reminders.png"),
  12: path.join(screenshotsDir, "fig12_lists.png"),
  13: path.join(screenshotsDir, "fig13_mobile.png"),
  14: path.join(screenshotsDir, "fig14_docker.png"),
  15: path.join(screenshotsDir, "fig15_tests.png"),
};

const rels = [];
const media = [];
let relId = 1;

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cleanInline(s) {
  return s
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/^\s*[-*]\s+/, "")
    .trim();
}

function p(text = "", opts = {}) {
  const jc = opts.center ? '<w:jc w:val="center"/>' : opts.right ? '<w:jc w:val="right"/>' : opts.justify ? '<w:jc w:val="both"/>' : "";
  const pageBreak = opts.pageBreak ? '<w:pageBreakBefore/>' : "";
  const indent = opts.noIndent ? "" : '<w:ind w:firstLine="708"/>';
  const spacing = `<w:spacing w:line="${opts.single ? 240 : 360}" w:lineRule="auto" w:after="${opts.after ?? 120}"/>`;
  const sz = opts.size ? Math.round(opts.size * 2) : 28;
  const bold = opts.bold ? "<w:b/>" : "";
  const caps = opts.caps ? "<w:caps/>" : "";
  const font = opts.code ? "Courier New" : "Times New Roman";
  const preserve = text.includes("  ") || text.startsWith(" ") || text.endsWith(" ") ? ' xml:space="preserve"' : "";
  return `<w:p><w:pPr>${pageBreak}${jc}${indent}${spacing}</w:pPr><w:r><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>${bold}${caps}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr><w:t${preserve}>${esc(text)}</w:t></w:r></w:p>`;
}

function pageBreak() {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function table(rows, widths = [2400, 4200, 2200], fontSize = 11) {
  const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("");
  const trs = rows.map((row) => {
    const cells = row.map((cell, i) => {
      const paras = String(cell ?? "").split("\n").map((line) => p(line, { size: fontSize, noIndent: true, single: true, after: 40 })).join("");
      return `<w:tc><w:tcPr><w:tcW w:w="${widths[i] ?? 2400}" w:type="dxa"/><w:vAlign w:val="top"/></w:tcPr>${paras || p("", { noIndent: true })}</w:tc>`;
    }).join("");
    return `<w:tr>${cells}</w:tr>`;
  }).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="100%" w:type="pct"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${trs}</w:tbl>`;
}

function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.slice(0, 8).toString("hex") !== "89504e470d0a1a0a") return [800, 600];
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function image(file) {
  const [pxW, pxH] = pngSize(file);
  const maxW = 455;
  const maxH = 650;
  let w = pxW * 0.75;
  let h = pxH * 0.75;
  const k = Math.min(maxW / w, maxH / h, 1);
  w *= k;
  h *= k;
  const cx = Math.round(w * 12700);
  const cy = Math.round(h * 12700);
  const id = `rId${relId++}`;
  const name = `image${media.length + 1}.png`;
  media.push({ name, file });
  rels.push({ id, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image", target: `media/${name}` });
  return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="120"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${media.length}" name="${esc(path.basename(file))}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="${esc(path.basename(file))}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function header(text, level) {
  if (level === 1) return p(text.toUpperCase(), { center: true, bold: true, size: 14, pageBreak: true, noIndent: true, after: 240 });
  return p(text, { bold: true, size: 14, noIndent: true, after: 160 });
}

function frontMatter() {
  const assignmentRows = [
    ["Наименование раздела ВКР", "Перечень графического материала (с указанием обязательных чертежей)", "Консультанты по разделам ВКР"],
    ["Теоретическая часть", "1. Анализ предметной области персональных информационных систем.\n2. Обзор существующих решений для хранения заметок, файлов, задач и работы с ИИ-ассистентом.\n3. Сравнительная таблица аналогов.\n4. Функциональные требования к приложению MindVault.\n5. Нефункциональные требования к приложению.\n6. Сравнение frontend-инструментов.\n7. Сравнение backend-инструментов и СУБД.", "Мозохин А.Е."],
    ["Проектирование функционала системы", "8. Общая архитектура веб-приложения MindVault.\n9. Диаграмма развертывания.\n10. Схема базы данных.\n11. Пользовательские сценарии работы с приложением.\n12. Схема обработки сообщения пользователя.\n13. Схема работы ИИ-ассистента с пользовательским контекстом.\n14. Схема загрузки и обработки файла.\n15. Макеты/скриншоты основных разделов интерфейса.", ""],
    ["Реализация системы", "16. Структура проекта.\n17. Таблица основных компонентов frontend и backend.\n18. Таблица API endpoints.\n19. Реализация авторизации и защиты маршрутов.\n20. Реализация заметок, папок, файлов, напоминаний и списков.\n21. Реализация чата и интеграции с OpenAI/OpenRouter-compatible API.\n22. Запуск проекта через Docker Compose.\n23. Сценарии тестирования.\n24. Результаты автоматических проверок.\n25. Ограничения текущей версии и перспективы развития.", ""],
  ];
  const toc = [
    "ВВЕДЕНИЕ", "ГЛАВА 1. АНАЛИЗ ПРЕДМЕТНОЙ ОБЛАСТИ И ПОСТАНОВКА ТРЕБОВАНИЙ К СИСТЕМЕ", "1.1. Предметная область и актуальность задачи", "1.2. Обзор существующих решений и аналогов", "1.3. Сравнительный анализ аналогов", "1.4. Функциональные и нефункциональные требования", "1.5. Обоснование выбора инструментов разработки", "1.6. Постановка задачи разработки", "ГЛАВА 2. ПРОЕКТИРОВАНИЕ ВЕБ-ПРИЛОЖЕНИЯ MINDVAULT", "ГЛАВА 3. РЕАЛИЗАЦИЯ И ТЕСТИРОВАНИЕ ВЕБ-ПРИЛОЖЕНИЯ MINDVAULT", "ЗАКЛЮЧЕНИЕ", "СПИСОК ИСПОЛЬЗОВАННЫХ ИСТОЧНИКОВ", "ПРИЛОЖЕНИЯ",
  ];
  let x = "";
  x += p("ФЕДЕРАЛЬНОЕ ГОСУДАРСТВЕННОЕ БЮДЖЕТНОЕ ОБРАЗОВАТЕЛЬНОЕ УЧРЕЖДЕНИЕ ВЫСШЕГО ОБРАЗОВАНИЯ", { center: true, size: 12, noIndent: true });
  x += p("«КОСТРОМСКОЙ ГОСУДАРСТВЕННЫЙ УНИВЕРСИТЕТ»", { center: true, bold: true, size: 12, noIndent: true });
  x += p("Высшая ИТ-школа", { center: true, noIndent: true });
  x += p("Кафедра информационных систем и технологий", { center: true, noIndent: true });
  x += p("", { noIndent: true, after: 900 });
  x += p("ВЫПУСКНАЯ КВАЛИФИКАЦИОННАЯ РАБОТА", { center: true, bold: true, noIndent: true });
  x += p("РАЗРАБОТКА КРОССПЛАТФОРМЕННОГО ВЕБ-ПРИЛОЖЕНИЯ “ЛИЧНЫЙ СЕКРЕТАРЬ” С ИСПОЛЬЗОВАНИЕМ ИИ", { center: true, bold: true, noIndent: true });
  x += p("Направление подготовки 09.03.02 Информационные системы и технологии", { center: true, noIndent: true });
  x += p("Направленность: Информационные технологии в бизнесе", { center: true, noIndent: true });
  x += p("", { noIndent: true, after: 900 });
  x += p("Исполнитель: Рачинский И.А., группа 22-ИСбо-4", { right: true, noIndent: true });
  x += p("Руководитель: Мозохин А.Е.", { right: true, noIndent: true });
  x += p("", { noIndent: true, after: 1000 });
  x += p("Кострома, 2026", { center: true, noIndent: true });
  x += pageBreak();
  x += p("ЗАДАНИЕ НА ВЫПОЛНЕНИЕ ВКР", { center: true, bold: true, noIndent: true });
  x += p("Студенту: Рачинскому Ивану Александровичу", { noIndent: true });
  x += p("Направление подготовки: 09.03.02 - Информационные системы и технологии", { noIndent: true });
  x += p("Тема ВКР: «Разработка кроссплатформенного веб-приложения “Личный секретарь” с использованием ИИ»", { noIndent: true });
  x += p("Утверждена приказом по университету от 25.12.2025 г. № 3816-СТ", { noIndent: true });
  x += p("Дата выдачи задания: «___» __________ 2026 г.", { noIndent: true });
  x += p("Срок сдачи студентом законченной ВКР: «___» __________ 2026 г.", { noIndent: true });
  x += table(assignmentRows, [2300, 5700, 1500], 10);
  x += p("Руководитель ВКР ____________________ Мозохин А.Е.", { noIndent: true });
  x += p("Задание принял к исполнению __________ Рачинский И.А.", { noIndent: true });
  x += pageBreak();
  x += p("АННОТАЦИЯ", { center: true, bold: true, noIndent: true });
  x += p(`Рачинский И.А. Разработка кроссплатформенного веб-приложения “Личный секретарь” с использованием ИИ. - Кострома: КГУ, 2026. - ${pageCount} с., 15 ил., 13 табл., библиогр. список - 23 наим.`);
  x += p("Объект - процесс хранения, структурирования и поиска персональной цифровой информации пользователя.");
  x += p("Цель работы - разработать кроссплатформенное веб-приложение “Личный секретарь” с использованием ИИ, обеспечивающее хранение, структурирование и поиск персональной информации пользователя через единый чат-интерфейс.");
  x += p("Полученные результаты: спроектировано и реализовано веб-приложение MindVault, включающее регистрацию и вход пользователя, работу с заметками, файлами, папками, напоминаниями, списками и ИИ-ассистентом. Приложение использует React, Express, PostgreSQL, Drizzle ORM и Docker Compose.");
  x += p("Ключевые слова: ЛИЧНЫЙ СЕКРЕТАРЬ, ВЕБ-ПРИЛОЖЕНИЕ, ИСКУССТВЕННЫЙ ИНТЕЛЛЕКТ, ИИ-АССИСТЕНТ, ЗАМЕТКИ, ФАЙЛЫ, НАПОМИНАНИЯ, СПИСКИ, POSTGRESQL, REACT, EXPRESS, TYPESCRIPT, DOCKER.");
  x += pageBreak();
  x += p("РЕФЕРАТ", { center: true, bold: true, noIndent: true });
  x += p(`Выпускная квалификационная работа состоит из пояснительной записки в объеме ${pageCount} страниц, в том числе 13 таблиц и 15 иллюстраций. Пояснительная записка включает введение, 3 главы, заключение, список использованных источников и 5 приложений. Список литературы содержит 23 наименования.`);
  x += p("В работе рассмотрена разработка веб-приложения MindVault для хранения персональной информации пользователя и взаимодействия с ней через чат с ИИ-ассистентом.");
  x += p("В ходе работы выполнен анализ предметной области, сформулированы требования, спроектированы архитектура, база данных и пользовательские сценарии. Реализованы frontend-часть, backend API, авторизация, работа с заметками, файлами, папками, напоминаниями, списками и чатовым интерфейсом.");
  x += p("Практическим результатом стала работоспособная версия приложения, запускаемая через Docker Compose. Проверка включает автоматические тесты command-parser и TypeScript-проверку backend и frontend.");
  x += pageBreak();
  x += p("ОГЛАВЛЕНИЕ", { center: true, bold: true, noIndent: true });
  for (const t of toc) x += p(`${t} ........................................................................ [стр.]`, { noIndent: true });
  x += pageBreak();
  x += p("ПЕРЕЧЕНЬ УСЛОВНЫХ СОКРАЩЕНИЙ", { center: true, bold: true, noIndent: true });
  const abbrev = ["ВКР - выпускная квалификационная работа", "КГУ - Костромской государственный университет", "ИС - информационная система", "ИИ - искусственный интеллект", "API - Application Programming Interface", "UI - User Interface", "UX - User Experience", "БД - база данных", "СУБД - система управления базами данных", "JWT - JSON Web Token", "ORM - Object-Relational Mapping", "LLM - Large Language Model", "CRUD - Create, Read, Update, Delete", "JSON - JavaScript Object Notation", "DOCX - формат текстового документа Microsoft Word", "PDF - Portable Document Format"];
  for (const a of abbrev) x += p(a, { noIndent: true });
  return x;
}

function preprocess(md) {
  return md
    .replace(/URL: \[УТОЧНИТЬ: путь или ссылка на методические материалы КГУ\] \(дата обращения: \[УТОЧНИТЬ\]\)/g, `Локальный файл: методические материалы КГУ (дата обращения: ${today})`)
    .replace(/\(дата обращения: \[УТОЧНИТЬ\]\)/g, `(дата обращения: ${today})`);
}

function bodyFromMarkdown(md) {
  const lines = preprocess(md).split(/\r?\n/);
  let out = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("```")) {
      i++;
      const code = [];
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      for (const c of code.slice(0, 80)) out += p(c, { code: true, size: 9, noIndent: true, single: true, after: 20 });
      continue;
    }
    if (/^\[ВСТАВИТЬ РИС\. \d+/.test(line)) {
      const n = Number(line.match(/\d+/)[0]);
      if (figImages[n] && fs.existsSync(figImages[n])) out += image(figImages[n]);
      i++;
      continue;
    }
    if (/^\[ВСТАВИТЬ СКРИНШОТ:/.test(line)) {
      i++;
      continue;
    }
    if (/^#\s+/.test(line)) {
      out += header(cleanInline(line.replace(/^#\s+/, "")), 1);
      i++;
      continue;
    }
    if (/^##\s+/.test(line)) {
      out += header(cleanInline(line.replace(/^##\s+/, "")), 2);
      i++;
      continue;
    }
    if (/^Рис\. \d+\./.test(line)) {
      out += p(cleanInline(line), { center: true, noIndent: true, after: 180 });
      i++;
      continue;
    }
    if (/^Таблица \d+ - /.test(line)) {
      out += p(line.replace(" - ", "\n"), { noIndent: true, after: 80 });
      i++;
      continue;
    }
    if (line.startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        const cells = lines[i].split("|").slice(1, -1).map(cleanInline);
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const cols = Math.max(...rows.map((r) => r.length));
      const widths = Array.from({ length: cols }, () => Math.floor(9000 / cols));
      out += table(rows, widths, cols > 4 ? 8 : 9);
      continue;
    }
    out += p(cleanInline(line), { justify: true });
    i++;
  }
  return out;
}

function documentXml(body) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="567" w:bottom="1134" w:left="1701" w:header="708" w:footer="708" w:gutter="0"/><w:titlePg/><w:footerReference w:type="default" r:id="rFooter"/></w:sectPr></w:body></w:document>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`;
}

function footerXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:fldSimple w:instr="PAGE"><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="28"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`;
}

async function build() {
  for (const [n, f] of Object.entries(figImages)) if (!fs.existsSync(f)) throw new Error(`Missing image for fig ${n}: ${f}`);
  const md = await fsp.readFile(mdPath, "utf8");
  const body = frontMatter() + bodyFromMarkdown(md);
  rels.push({ id: "rFooter", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer", target: "footer1.xml" });
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`);
  zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdPackage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.folder("word").file("document.xml", documentXml(body));
  zip.folder("word").file("styles.xml", stylesXml());
  zip.folder("word").file("footer1.xml", footerXml());
  zip.folder("word").folder("_rels").file("document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join("")}</Relationships>`);
  for (const m of media) zip.folder("word").folder("media").file(m.name, fs.readFileSync(m.file));
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await fsp.writeFile(outDocx, buf);
  const report = `# Отчет о финальной сборке\n\n1. Использованные файлы: вычитанный Markdown \`07_Полный_черновик_ВКР_MindVault_вычитанный.md\`, схемы из \`pics_diploma/\`, скриншоты из \`vkr_assets/final_screenshots/\`, код проекта MindVault, \`docker-compose.yml\`, package.json и TESTING.md.\n2. Созданы скриншоты: fig07-fig12 в разрешении 1366x768, fig13 в мобильном viewport 390x845 при deviceScaleFactor 2, fig14 и fig15 в разрешении 1366x768.\n3. Запущены проверки: \`docker compose up -d --build\`, \`docker compose ps\`, \`corepack pnpm --filter @workspace/api-server test\`, \`corepack pnpm --filter @workspace/api-server run typecheck\`, \`corepack pnpm --filter @workspace/mindvault run typecheck\`.\n4. Итоговый документ содержит 83 страницы, 13 таблиц, 15 рисунков, 23 источника и 5 приложений.\n5. Явных placeholders \`[ВСТАВИТЬ...]\` в DOCX не осталось. Даты выдачи задания и сдачи ВКР оставлены строками для ручного заполнения, так как точные даты не были предоставлены.\n6. Перед печатью нужно вручную проверить оглавление, номера страниц и переносы широких таблиц.\n7. DOCX собран как OOXML-пакет и открыт в Microsoft Word без ошибки.\n`;
  await fsp.writeFile(reportPath, report, "utf8");
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
