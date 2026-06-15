import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZipModule from "../../node_modules/.pnpm/jszip@3.10.1/node_modules/jszip/lib/index.js";

const JSZip = JSZipModule.default ?? JSZipModule;

const workspaceRoot = "D:/Univer/AI-Workspace-Hub";
const outputPath = path.join(workspaceRoot, "ВКР_Рачинский_Иван_MindVault_каркас_исправленный.docx");

const ns =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function twipsCm(value) {
  return Math.round(value * 567);
}

function r(text, options = {}) {
  const props = [];
  if (options.bold) props.push("<w:b/>");
  if (options.italic) props.push("<w:i/>");
  if (options.size) props.push(`<w:sz w:val="${Math.round(options.size * 2)}"/>`);
  const rPr = props.length ? `<w:rPr>${props.join("")}</w:rPr>` : "";
  return `<w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function textRuns(text, options = {}) {
  return String(text ?? "")
    .split("\n")
    .map((part, index) => `${index ? "<w:r><w:br/></w:r>" : ""}${r(part, options)}`)
    .join("");
}

function p(text = "", options = {}) {
  const style = options.style ? `<w:pStyle w:val="${options.style}"/>` : "";
  const jc = options.align ? `<w:jc w:val="${options.align}"/>` : "";
  const indent = options.noIndent ? "" : '<w:ind w:firstLine="708"/>';
  const spacing = `<w:spacing w:line="${options.line ?? 360}" w:lineRule="auto" w:after="${options.after ?? 120}"/>`;
  const pageBreak = options.pageBreakBefore ? "<w:pageBreakBefore/>" : "";
  const keep = options.keepNext ? "<w:keepNext/>" : "";
  return `<w:p><w:pPr>${style}${pageBreak}${keep}${jc}${indent}${spacing}</w:pPr>${textRuns(text, options)}</w:p>`;
}

function pageBreak() {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function h1(text) {
  return p(text.toUpperCase(), { style: "Heading1", align: "center", noIndent: true, bold: true, pageBreakBefore: true, after: 240 });
}

function frontH1(text) {
  return p(text.toUpperCase(), { align: "center", noIndent: true, bold: true, pageBreakBefore: true, after: 240 });
}

function h2(text) {
  return p(text, { style: "Heading2", noIndent: true, bold: true, keepNext: true, after: 120 });
}

function centered(text, options = {}) {
  return p(text, { ...options, align: "center", noIndent: true });
}

function right(text, options = {}) {
  return p(text, { ...options, align: "right", noIndent: true });
}

function cellParagraph(text, options = {}) {
  const align = options.align ? `<w:jc w:val="${options.align}"/>` : "";
  const spacing = '<w:spacing w:line="276" w:lineRule="auto" w:after="40"/>';
  const props = [];
  if (options.bold) props.push("<w:b/>");
  props.push(`<w:sz w:val="${options.size ?? 22}"/>`);
  const rPr = `<w:rPr>${props.join("")}</w:rPr>`;
  const lines = String(text ?? "").split("\n");
  const runs = lines
    .map((line, index) => `${index ? "<w:r><w:br/></w:r>" : ""}<w:r>${rPr}<w:t xml:space="preserve">${esc(line)}</w:t></w:r>`)
    .join("");
  return `<w:p><w:pPr>${align}<w:spacing w:line="276" w:lineRule="auto" w:after="40"/></w:pPr>${runs}</w:p>`;
}

function tc(content, options = {}) {
  const width = options.width ? `<w:tcW w:w="${options.width}" w:type="dxa"/>` : "";
  const vMerge = options.vMerge ? `<w:vMerge w:val="${options.vMerge}"/>` : "";
  const shade = options.shade ? `<w:shd w:fill="${options.shade}"/>` : "";
  const vAlign = options.vAlign ? `<w:vAlign w:val="${options.vAlign}"/>` : "";
  const margins =
    '<w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tcMar>';
  const body = Array.isArray(content) ? content.join("") || cellParagraph("") : cellParagraph(content);
  return `<w:tc><w:tcPr>${width}${vMerge}${shade}${vAlign}${margins}</w:tcPr>${body}</w:tc>`;
}

function table(rows, options = {}) {
  const borders =
    '<w:tblBorders><w:top w:val="single" w:sz="6" w:space="0" w:color="000000"/><w:left w:val="single" w:sz="6" w:space="0" w:color="000000"/><w:bottom w:val="single" w:sz="6" w:space="0" w:color="000000"/><w:right w:val="single" w:sz="6" w:space="0" w:color="000000"/><w:insideH w:val="single" w:sz="6" w:space="0" w:color="000000"/><w:insideV w:val="single" w:sz="6" w:space="0" w:color="000000"/></w:tblBorders>';
  const layout = options.fixed ? '<w:tblLayout w:type="fixed"/>' : "";
  const width = `<w:tblW w:w="${options.width ?? 9638}" w:type="dxa"/>`;
  return `<w:tbl><w:tblPr>${width}${layout}${borders}</w:tblPr>${rows.map((row) => `<w:tr>${row.join("")}</w:tr>`).join("")}</w:tbl>`;
}

function simpleTable(headers, rows, widths) {
  const headerRow = headers.map((header, index) =>
    tc([cellParagraph(header, { bold: true, align: "center" })], { width: widths[index], shade: "F2F2F2", vAlign: "center" }),
  );
  const bodyRows = rows.map((row) => row.map((cell, index) => tc([cellParagraph(cell, { align: index === 0 ? "center" : undefined })], { width: widths[index] })));
  return table([headerRow, ...bodyRows], { fixed: true });
}

function tocLine(title, page = "[УТОЧНИТЬ]") {
  return p(`${title} ........................................................................ ${page}`, { noIndent: true, after: 40 });
}

function numberedItems(items) {
  return items.map((item) => cellParagraph(item, { size: 20 }));
}

const parts = [];

parts.push(centered("МИНОБРНАУКИ РОССИИ", { after: 60 }));
parts.push(centered("Федеральное государственное бюджетное образовательное учреждение высшего образования", { after: 60 }));
parts.push(centered("«Костромской государственный университет»", { after: 180 }));
parts.push(centered("Высшая ИТ-школа", { after: 60 }));
parts.push(centered("Кафедра информационных систем и технологий", { after: 240 }));
parts.push(right("Допущено к защите", { after: 40 }));
parts.push(right("Заведующий кафедрой", { after: 40 }));
parts.push(right("______________ [УТОЧНИТЬ]", { after: 40 }));
parts.push(right("«___» __________ 2026 г.", { after: 260 }));
parts.push(centered("ВЫПУСКНАЯ КВАЛИФИКАЦИОННАЯ РАБОТА", { bold: true, after: 120 }));
parts.push(centered("по направлению подготовки 09.03.02 Информационные системы и технологии", { after: 80 }));
parts.push(centered("направленность: Информационные технологии в бизнесе", { after: 220 }));
parts.push(centered("РАЗРАБОТКА КРОССПЛАТФОРМЕННОГО ВЕБ-ПРИЛОЖЕНИЯ\n“ЛИЧНЫЙ СЕКРЕТАРЬ” С ИСПОЛЬЗОВАНИЕМ ИИ", { bold: true, after: 260 }));
parts.push(centered("Выпускная квалификационная работа", { after: 280 }));
parts.push(
  table(
    [
      [
        tc("", { width: 4300 }),
        tc(
          [
            cellParagraph("Исполнитель:", { size: 24 }),
            cellParagraph("студент 4 курса очной формы обучения", { size: 24 }),
            cellParagraph("группы 22-ИСбо-4", { size: 24 }),
            cellParagraph("______________ Рачинский И.А.", { size: 24 }),
            cellParagraph("", { size: 24 }),
            cellParagraph("Руководитель:", { size: 24 }),
            cellParagraph("______________ Мозохин А.Е.", { size: 24 }),
          ],
          { width: 5300 },
        ),
      ],
    ],
    { width: 9638, fixed: true },
  ).replaceAll('w:val="single"', 'w:val="nil"'),
);
parts.push(p("", { after: 900, noIndent: true }));
parts.push(centered("Кострома, 2026", { after: 0 }));

parts.push(frontH1("ЗАДАНИЕ НА ВЫПОЛНЕНИЕ ВКР"));
parts.push(centered("Федеральное государственное бюджетное образовательное учреждение высшего образования", { after: 40 }));
parts.push(centered("«Костромской государственный университет»", { after: 160 }));
parts.push(p("Студенту: Рачинскому Ивану Александровичу"));
parts.push(p("Направление подготовки: 09.03.02 - Информационные системы и технологии"));
parts.push(p("Направленность: Информационные технологии в бизнесе"));
parts.push(p("Тема ВКР: «Разработка кроссплатформенного веб-приложения “Личный секретарь” с использованием ИИ»"));
parts.push(p("Утверждена приказом по университету от 25.12.2025 г. № 3816-СТ"));
parts.push(p("Срок сдачи студентом законченной ВКР: [УТОЧНИТЬ]"));
parts.push(p("Дата выдачи задания: [УТОЧНИТЬ]"));
parts.push(p("Исходные данные к работе: материалы проекта MindVault, примеры ВКР кафедры, правила оформления документов КГУ, техническая документация используемых технологий."));
parts.push(p("Содержание расчетно-пояснительной записки определяется следующими разделами и графическими материалами.", { noIndent: true }));

const assignmentHeader = [
  tc([cellParagraph("Наименование раздела ВКР", { bold: true, align: "center", size: 20 })], { width: 2100, shade: "F2F2F2", vAlign: "center" }),
  tc([cellParagraph("Перечень графического материала (с указанием обязательных чертежей)", { bold: true, align: "center", size: 20 })], {
    width: 5900,
    shade: "F2F2F2",
    vAlign: "center",
  }),
  tc([cellParagraph("Консультанты по разделам ВКР", { bold: true, align: "center", size: 20 })], { width: 1638, shade: "F2F2F2", vAlign: "center" }),
];

const assignmentRows = [
  [
    tc([cellParagraph("Теоретическая часть", { size: 20 })], { width: 2100, vAlign: "center" }),
    tc(
      numberedItems([
        "1. Анализ предметной области персональных информационных систем.",
        "2. Обзор существующих решений для хранения заметок, файлов, задач и работы с ИИ-ассистентом.",
        "3. Сравнительная таблица аналогов.",
        "4. Функциональные требования к приложению MindVault.",
        "5. Нефункциональные требования к приложению.",
        "6. Сравнение frontend-инструментов.",
        "7. Сравнение backend-инструментов и СУБД.",
      ]),
      { width: 5900 },
    ),
    tc([cellParagraph("Мозохин А.Е.", { align: "center", size: 20 })], { width: 1638, vAlign: "center" }),
  ],
  [
    tc([cellParagraph("Проектирование функционала системы", { size: 20 })], { width: 2100, vAlign: "center" }),
    tc(
      numberedItems([
        "8. Общая архитектура веб-приложения MindVault.",
        "9. Диаграмма развертывания.",
        "10. Схема базы данных.",
        "11. Пользовательские сценарии работы с приложением.",
        "12. Схема обработки сообщения пользователя.",
        "13. Схема работы ИИ-ассистента с пользовательским контекстом.",
        "14. Схема загрузки и обработки файла.",
        "15. Макеты/скриншоты основных разделов интерфейса.",
      ]),
      { width: 5900 },
    ),
    tc([cellParagraph("", { align: "center", size: 20 })], { width: 1638, vAlign: "center" }),
  ],
  [
    tc([cellParagraph("Реализация системы", { size: 20 })], { width: 2100, vAlign: "center" }),
    tc(
      numberedItems([
        "16. Структура проекта.",
        "17. Таблица основных компонентов frontend и backend.",
        "18. Таблица API endpoints.",
        "19. Реализация авторизации и защиты маршрутов.",
        "20. Реализация заметок, папок, файлов, напоминаний и списков.",
        "21. Реализация чата и интеграции с OpenAI/OpenRouter-compatible API.",
        "22. Запуск проекта через Docker Compose.",
        "23. Сценарии тестирования.",
        "24. Результаты автоматических проверок.",
        "25. Ограничения текущей версии и перспективы развития.",
      ]),
      { width: 5900 },
    ),
    tc([cellParagraph("", { align: "center", size: 20 })], { width: 1638, vAlign: "center" }),
  ],
];

parts.push(table([assignmentHeader, ...assignmentRows], { fixed: true }));
parts.push(p("Руководитель ВКР ____________________ Мозохин А.Е.", { noIndent: true, after: 80 }));
parts.push(p("Задание принял к исполнению ____________________ Рачинский И.А.", { noIndent: true, after: 80 }));

parts.push(frontH1("АННОТАЦИЯ"));
parts.push(
  p(
    "Рачинский И.А. Разработка кроссплатформенного веб-приложения “Личный секретарь” с использованием ИИ. - Кострома: КГУ, 2026. - [УТОЧНИТЬ] с., [УТОЧНИТЬ] ил., [УТОЧНИТЬ] табл., библиогр. список - [УТОЧНИТЬ] наим.",
  ),
);
parts.push(p("Объект - процесс хранения, структурирования и поиска персональной цифровой информации пользователя."));
parts.push(
  p(
    "Цель работы - разработать кроссплатформенное веб-приложение “Личный секретарь” с использованием ИИ, обеспечивающее хранение, структурирование и поиск персональной информации пользователя через единый чат-интерфейс.",
  ),
);
parts.push(
  p(
    "Полученные результаты: в рамках работы спроектировано и реализовано веб-приложение MindVault, включающее регистрацию и вход пользователя, работу с заметками, файлами, папками, напоминаниями, списками и ИИ-ассистентом. Приложение использует React, Express, PostgreSQL, Drizzle ORM и Docker Compose. ИИ-ассистент работает через OpenAI/OpenRouter-совместимый API и использует сохраненный пользовательский контекст при формировании ответа.",
  ),
);
parts.push(
  p(
    "Ключевые слова: ЛИЧНЫЙ СЕКРЕТАРЬ, ВЕБ-ПРИЛОЖЕНИЕ, ИСКУССТВЕННЫЙ ИНТЕЛЛЕКТ, ИИ-АССИСТЕНТ, ЗАМЕТКИ, ФАЙЛЫ, НАПОМИНАНИЯ, СПИСКИ, POSTGRESQL, REACT, EXPRESS, TYPESCRIPT, DOCKER, КРОССПЛАТФОРМЕННОСТЬ.",
  ),
);

parts.push(frontH1("РЕФЕРАТ"));
parts.push(
  p(
    "Выпускная квалификационная работа состоит из пояснительной записки в объеме [УТОЧНИТЬ] страниц, в том числе [УТОЧНИТЬ] таблиц и [УТОЧНИТЬ] иллюстраций. Пояснительная записка включает введение, 3 главы, заключение, список использованных источников и приложения. Список литературы содержит [УТОЧНИТЬ] наименований.",
  ),
);
parts.push(
  p(
    "Целью выпускной квалификационной работы является разработка кроссплатформенного веб-приложения “Личный секретарь” с использованием ИИ для хранения, структурирования и поиска персональной цифровой информации пользователя.",
  ),
);
parts.push(
  p(
    "В ходе работы предполагается выполнить анализ предметной области и существующих решений, сформулировать требования к системе, спроектировать архитектуру приложения MindVault, базу данных, пользовательский интерфейс, логику работы ИИ-ассистента и подсистему обработки файлов.",
  ),
);
parts.push(
  p(
    "Результатом работы является каркас описания программного продукта MindVault и последующее наполнение глав материалами о реализации frontend-части, backend-части, API, базы данных, функций заметок, файлов, папок, напоминаний, списков, чата и тестирования системы.",
  ),
);

parts.push(frontH1("ОГЛАВЛЕНИЕ"));
[
  "ПЕРЕЧЕНЬ УСЛОВНЫХ СОКРАЩЕНИЙ",
  "ВВЕДЕНИЕ",
  "ГЛАВА 1. АНАЛИЗ ПРЕДМЕТНОЙ ОБЛАСТИ И ПОСТАНОВКА ТРЕБОВАНИЙ К СИСТЕМЕ",
  "1.1. Предметная область и актуальность задачи",
  "1.2. Обзор существующих решений и аналогов",
  "1.3. Сравнительный анализ аналогов",
  "1.4. Функциональные и нефункциональные требования",
  "1.5. Обоснование выбора инструментов разработки",
  "1.6. Постановка задачи разработки",
  "Выводы по главе 1",
  "ГЛАВА 2. ПРОЕКТИРОВАНИЕ ВЕБ-ПРИЛОЖЕНИЯ MINDVAULT",
  "2.1. Общая концепция приложения",
  "2.2. Пользовательские сценарии",
  "2.3. Архитектура системы",
  "2.4. Проектирование базы данных",
  "2.5. Проектирование ИИ-ассистента",
  "2.6. Проектирование работы с файлами",
  "2.7. Проектирование пользовательского интерфейса",
  "2.8. Проектирование подсистемы безопасности",
  "Выводы по главе 2",
  "ГЛАВА 3. РЕАЛИЗАЦИЯ И ТЕСТИРОВАНИЕ ВЕБ-ПРИЛОЖЕНИЯ MINDVAULT",
  "3.1. Общая структура проекта",
  "3.2. Реализация frontend-части",
  "3.3. Реализация backend-части и API",
  "3.4. Реализация базы данных",
  "3.5. Реализация ИИ-ассистента",
  "3.6. Реализация работы с файлами",
  "3.7. Реализация заметок, папок, напоминаний и списков",
  "3.8. Сборка и запуск проекта",
  "3.9. Тестирование системы",
  "3.10. Ограничения текущей версии и перспективы развития",
  "Выводы по главе 3",
  "ЗАКЛЮЧЕНИЕ",
  "СПИСОК ИСПОЛЬЗОВАННЫХ ИСТОЧНИКОВ",
  "ПРИЛОЖЕНИЕ 1. Фрагменты исходного кода",
  "ПРИЛОЖЕНИЕ 2. Расширенный перечень тестовых сценариев",
  "ПРИЛОЖЕНИЕ 3. Дополнительные скриншоты интерфейса",
  "ПРИЛОЖЕНИЕ 4. Инструкция по запуску приложения через Docker",
  "ПРИЛОЖЕНИЕ 5. Структура проекта",
].forEach((title) => parts.push(tocLine(title)));

parts.push(h1("ПЕРЕЧЕНЬ УСЛОВНЫХ СОКРАЩЕНИЙ"));
parts.push(
  simpleTable(
    ["Сокращение", "Расшифровка"],
    [
      ["ВКР", "выпускная квалификационная работа"],
      ["КГУ", "Костромской государственный университет"],
      ["ИС", "информационная система"],
      ["ИИ", "искусственный интеллект"],
      ["API", "Application Programming Interface"],
      ["UI", "User Interface"],
      ["UX", "User Experience"],
      ["БД", "база данных"],
      ["СУБД", "система управления базами данных"],
      ["JWT", "JSON Web Token"],
      ["ORM", "Object-Relational Mapping"],
      ["LLM", "Large Language Model"],
      ["CRUD", "Create, Read, Update, Delete"],
      ["JSON", "JavaScript Object Notation"],
      ["DOCX", "формат текстового документа Microsoft Word"],
      ["PDF", "Portable Document Format"],
    ],
    [1700, 7938],
  ),
);

parts.push(h1("ВВЕДЕНИЕ"));
parts.push(p("[БУДЕТ НАПИСАНО НА СЛЕДУЮЩЕМ ЭТАПЕ]", { noIndent: true }));

parts.push(h1("ГЛАВА 1. АНАЛИЗ ПРЕДМЕТНОЙ ОБЛАСТИ И ПОСТАНОВКА ТРЕБОВАНИЙ К СИСТЕМЕ"));
[
  "1.1. Предметная область и актуальность задачи",
  "1.2. Обзор существующих решений и аналогов",
  "1.3. Сравнительный анализ аналогов",
  "1.4. Функциональные и нефункциональные требования",
  "1.5. Обоснование выбора инструментов разработки",
  "1.6. Постановка задачи разработки",
  "Выводы по главе 1",
].forEach((title) => parts.push(h2(title)));

parts.push(h1("ГЛАВА 2. ПРОЕКТИРОВАНИЕ ВЕБ-ПРИЛОЖЕНИЯ MINDVAULT"));
[
  "2.1. Общая концепция приложения",
  "2.2. Пользовательские сценарии",
  "2.3. Архитектура системы",
  "2.4. Проектирование базы данных",
  "2.5. Проектирование ИИ-ассистента",
  "2.6. Проектирование работы с файлами",
  "2.7. Проектирование пользовательского интерфейса",
  "2.8. Проектирование подсистемы безопасности",
  "Выводы по главе 2",
].forEach((title) => parts.push(h2(title)));

parts.push(h1("ГЛАВА 3. РЕАЛИЗАЦИЯ И ТЕСТИРОВАНИЕ ВЕБ-ПРИЛОЖЕНИЯ MINDVAULT"));
[
  "3.1. Общая структура проекта",
  "3.2. Реализация frontend-части",
  "3.3. Реализация backend-части и API",
  "3.4. Реализация базы данных",
  "3.5. Реализация ИИ-ассистента",
  "3.6. Реализация работы с файлами",
  "3.7. Реализация заметок, папок, напоминаний и списков",
  "3.8. Сборка и запуск проекта",
  "3.9. Тестирование системы",
  "3.10. Ограничения текущей версии и перспективы развития",
  "Выводы по главе 3",
].forEach((title) => parts.push(h2(title)));

parts.push(h1("ЗАКЛЮЧЕНИЕ"));

parts.push(h1("СПИСОК ИСПОЛЬЗОВАННЫХ ИСТОЧНИКОВ"));
[
  "1. Костромской государственный университет. Правила оформления текстовых документов: методические рекомендации. Кострома, 2017.",
  "2. React Documentation. URL: https://react.dev/ (дата обращения: [УТОЧНИТЬ]).",
  "3. PostgreSQL Documentation. URL: https://www.postgresql.org/docs/ (дата обращения: [УТОЧНИТЬ]).",
].forEach((source) => parts.push(p(source, { noIndent: true })));

[
  "ПРИЛОЖЕНИЕ 1. Фрагменты исходного кода",
  "ПРИЛОЖЕНИЕ 2. Расширенный перечень тестовых сценариев",
  "ПРИЛОЖЕНИЕ 3. Дополнительные скриншоты интерфейса",
  "ПРИЛОЖЕНИЕ 4. Инструкция по запуску приложения через Docker",
  "ПРИЛОЖЕНИЕ 5. Структура проекта",
].forEach((title) => {
  parts.push(h1(title));
  parts.push(p("[СОДЕРЖАНИЕ ПРИЛОЖЕНИЯ БУДЕТ ДОБАВЛЕНО НА ФИНАЛЬНОМ ЭТАПЕ]", { noIndent: true }));
});

const sectPr = `<w:sectPr><w:footerReference w:type="first" r:id="rIdFooterFirst"/><w:footerReference w:type="default" r:id="rIdFooterDefault"/><w:titlePg/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${twipsCm(2)}" w:right="${twipsCm(1)}" w:bottom="${twipsCm(2)}" w:left="${twipsCm(3)}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${ns}><w:body>${parts.join("\n")}${sectPr}</w:body></w:document>`;

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/><w:color w:val="000000"/><w:sz w:val="28"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto" w:after="120"/><w:ind w:firstLine="708"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:line="360" w:lineRule="auto" w:after="120"/><w:ind w:firstLine="708"/><w:jc w:val="both"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/><w:color w:val="000000"/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:pageBreakBefore/><w:spacing w:line="360" w:lineRule="auto" w:after="240"/><w:jc w:val="center"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/><w:b/><w:color w:val="000000"/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:line="360" w:lineRule="auto" w:before="160" w:after="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/><w:b/><w:color w:val="000000"/><w:sz w:val="28"/></w:rPr></w:style>
</w:styles>`;

const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:updateFields w:val="true"/></w:settings>`;

const firstFooter = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p/></w:ftr>`;
const defaultFooter = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
</w:ftr>`;

const zip = new JSZip();
zip.file(
  "[Content_Types].xml",
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/word/footer2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`,
);
zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
zip.file(
  "word/_rels/document.xml.rels",
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rIdFooterFirst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/><Relationship Id="rIdFooterDefault" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer2.xml"/></Relationships>`,
);
zip.file("word/document.xml", documentXml);
zip.file("word/styles.xml", stylesXml);
zip.file("word/settings.xml", settingsXml);
zip.file("word/footer1.xml", firstFooter);
zip.file("word/footer2.xml", defaultFooter);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));

console.log(JSON.stringify({ outputPath }, null, 2));
