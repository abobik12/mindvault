import { mkdir, writeFile } from "node:fs/promises";

const outDir = new URL("../diagrams/html/", import.meta.url);
const svgDir = new URL("../diagrams/", import.meta.url);

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function text(x, y, lines, opts = {}) {
  const size = opts.size ?? 18;
  const weight = opts.weight ?? 400;
  const anchor = opts.anchor ?? "middle";
  const fill = opts.fill ?? "#111827";
  const arr = Array.isArray(lines) ? lines : [lines];
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Arial" font-size="${size}" font-weight="${weight}" fill="${fill}">${arr
    .map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : size + 5}">${esc(line)}</tspan>`)
    .join("")}</text>`;
}

function box(x, y, w, h, label, opts = {}) {
  const fill = opts.fill ?? "#ffffff";
  const stroke = opts.stroke ?? "#cbd5e1";
  const title = text(x + w / 2, y + 33, Array.isArray(label) ? label : [label], {
    size: opts.size ?? 17,
    weight: opts.weight ?? 600,
    fill: opts.textFill ?? "#0f172a",
  });
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${fill}" stroke="${stroke}" stroke-width="2"/>${title}`;
}

function arrow(x1, y1, x2, y2, label = "") {
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2 - 8;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#64748b" stroke-width="2.2" marker-end="url(#arrow)"/>${
    label ? text(midX, midY, label, { size: 13, fill: "#475569" }) : ""
  }`;
}

function page(title, body, height = 680) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  body { margin: 0; background: #f8fafc; }
  .wrap { width: 1180px; margin: 0 auto; padding: 28px 0; }
  svg { background: #ffffff; border: 1px solid #e2e8f0; box-shadow: 0 12px 30px rgba(15,23,42,.08); }
</style>
</head>
<body>
<div class="wrap">
<svg width="1180" height="${height}" viewBox="0 0 1180 ${height}" xmlns="http://www.w3.org/2000/svg">
<defs>
  <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
    <path d="M0,0 L0,6 L9,3 z" fill="#64748b"/>
  </marker>
</defs>
${text(590, 42, title, { size: 24, weight: 700 })}
${body}
</svg>
</div>
</body>
</html>`;
}

function svgPage(title, body, height = 680) {
  return `<svg width="1180" height="${height}" viewBox="0 0 1180 ${height}" xmlns="http://www.w3.org/2000/svg">
<rect width="1180" height="${height}" fill="#ffffff"/>
<defs>
  <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
    <path d="M0,0 L0,6 L9,3 z" fill="#64748b"/>
  </marker>
</defs>
${text(590, 42, title, { size: 24, weight: 700 })}
${body}
</svg>`;
}

const diagrams = [
  {
    file: "01-architecture.html",
    title: "Общая архитектура веб-приложения",
    body: [
      box(60, 115, 210, 110, ["Пользователь", "desktop / mobile"], { fill: "#eff6ff", stroke: "#93c5fd" }),
      box(350, 90, 250, 160, ["Frontend", "React + Vite", "TypeScript, Tailwind"], { fill: "#f0fdf4", stroke: "#86efac" }),
      box(690, 90, 250, 160, ["Backend API", "Node.js + Express", "валидация, бизнес-логика"], { fill: "#fff7ed", stroke: "#fdba74" }),
      box(480, 330, 230, 120, ["PostgreSQL", "Drizzle ORM", "данные пользователя"], { fill: "#f8fafc", stroke: "#94a3b8" }),
      box(820, 330, 230, 120, ["ИИ-провайдер", "OpenAI-compatible API", "ответы ассистента"], { fill: "#f5f3ff", stroke: "#c4b5fd" }),
      box(150, 330, 220, 120, ["Файлы", "base64 в БД", "извлечение текста"], { fill: "#ecfeff", stroke: "#67e8f9" }),
      arrow(270, 170, 350, 170, "HTTP"),
      arrow(600, 170, 690, 170, "REST API"),
      arrow(815, 250, 670, 330, "SQL"),
      arrow(940, 250, 935, 330, "контекст"),
      arrow(690, 385, 710, 385, ""),
      arrow(370, 390, 480, 390, "метаданные"),
    ].join("\n"),
  },
  {
    file: "02-deployment.html",
    title: "Диаграмма развертывания MindVault",
    body: [
      box(70, 130, 240, 120, ["Браузер пользователя", "Chrome, Edge, Firefox", "адаптивный UI"], { fill: "#eff6ff", stroke: "#93c5fd" }),
      box(410, 120, 290, 140, ["Контейнер web", "Vite preview", "порт 18174"], { fill: "#f0fdf4", stroke: "#86efac" }),
      box(800, 120, 290, 140, ["Контейнер api", "Express server", "порт 8080"], { fill: "#fff7ed", stroke: "#fdba74" }),
      box(535, 360, 300, 130, ["Контейнер db", "PostgreSQL 16", "volume pgdata"], { fill: "#f8fafc", stroke: "#94a3b8" }),
      box(860, 365, 220, 120, ["Внешний API", "LLM provider", "ключ в .env"], { fill: "#f5f3ff", stroke: "#c4b5fd" }),
      arrow(310, 190, 410, 190, "HTTP"),
      arrow(700, 190, 800, 190, "/api proxy"),
      arrow(945, 260, 760, 360, "DATABASE_URL"),
      arrow(945, 260, 970, 365, "HTTPS API"),
    ].join("\n"),
  },
  {
    file: "03-database.html",
    title: "Схема базы данных",
    body: [
      box(70, 110, 230, 150, ["users", "id PK", "email, password_hash", "full_name"], { fill: "#eff6ff", stroke: "#93c5fd", size: 15 }),
      box(410, 110, 250, 160, ["folders", "id PK, user_id FK", "name, color, icon", "is_system"], { fill: "#f0fdf4", stroke: "#86efac", size: 15 }),
      box(790, 100, 290, 190, ["items", "id PK, user_id FK", "folder_id FK", "type, title, content", "file_data, reminder_at"], { fill: "#fff7ed", stroke: "#fdba74", size: 15 }),
      box(210, 390, 260, 150, ["conversations", "id PK, user_id FK", "title, created_at"], { fill: "#f5f3ff", stroke: "#c4b5fd", size: 15 }),
      box(630, 390, 260, 160, ["messages", "id PK", "conversation_id FK", "role, content", "metadata"], { fill: "#ecfeff", stroke: "#67e8f9", size: 15 }),
      arrow(300, 185, 410, 185, "1:N"),
      arrow(660, 190, 790, 190, "1:N"),
      arrow(300, 230, 790, 260, "1:N"),
      arrow(300, 215, 210, 390, "1:N"),
      arrow(470, 465, 630, 465, "1:N"),
    ].join("\n"),
  },
  {
    file: "04-timeline.html",
    title: "Timeline обработки пользовательского сообщения",
    height: 760,
    body: [
      text(95, 105, "1", { weight: 700, fill: "#2563eb" }),
      text(95, 138, ["Открытие", "приложения"], { size: 14 }),
      text(245, 105, "2", { weight: 700, fill: "#2563eb" }),
      text(245, 138, ["Загрузка", "данных"], { size: 14 }),
      text(395, 105, "3", { weight: 700, fill: "#2563eb" }),
      text(395, 138, ["Отправка", "сообщения"], { size: 14 }),
      text(545, 105, "4", { weight: 700, fill: "#2563eb" }),
      text(545, 138, ["Запрос", "на backend"], { size: 14 }),
      text(695, 105, "5", { weight: 700, fill: "#2563eb" }),
      text(695, 138, ["Определение", "намерения"], { size: 14 }),
      text(845, 105, "6", { weight: 700, fill: "#2563eb" }),
      text(845, 138, ["Действие", "в БД"], { size: 14 }),
      text(995, 105, "7", { weight: 700, fill: "#2563eb" }),
      text(995, 138, ["Ответ", "ассистента"], { size: 14 }),
      text(1090, 105, "8", { weight: 700, fill: "#2563eb" }),
      text(1090, 138, ["Обновление", "UI"], { size: 14 }),
      `<line x1="95" y1="220" x2="1090" y2="220" stroke="#94a3b8" stroke-width="4"/>`,
      [95, 245, 395, 545, 695, 845, 995, 1090]
        .map((x) => `<circle cx="${x}" cy="220" r="12" fill="#2563eb"/>`)
        .join(""),
      box(70, 300, 250, 110, ["Frontend", "формирует payload", "прикладывает файлы"], { fill: "#f0fdf4", stroke: "#86efac", size: 15 }),
      box(465, 300, 250, 110, ["Backend", "классификация", "проверка прав"], { fill: "#fff7ed", stroke: "#fdba74", size: 15 }),
      box(835, 300, 250, 110, ["Результат", "запись сообщения", "обновление экрана"], { fill: "#eff6ff", stroke: "#93c5fd", size: 15 }),
      arrow(320, 355, 465, 355, "REST"),
      arrow(715, 355, 835, 355, "SSE/JSON"),
    ].join("\n"),
  },
  {
    file: "05-intent.html",
    title: "Алгоритм различения запроса и команды сохранения",
    height: 760,
    body: [
      box(475, 85, 230, 70, "Сообщение пользователя", { fill: "#eff6ff", stroke: "#93c5fd" }),
      box(430, 210, 320, 90, ["Есть явная команда?", "заметка / список / напоминание"], { fill: "#fff7ed", stroke: "#fdba74", size: 16 }),
      box(120, 370, 260, 100, ["Нет", "обычный вопрос", "ответ без автосохранения"], { fill: "#f8fafc", stroke: "#94a3b8", size: 16 }),
      box(460, 370, 260, 100, ["Да", "создать объект", "после записи в БД"], { fill: "#f0fdf4", stroke: "#86efac", size: 16 }),
      box(800, 370, 260, 100, ["Спорно", "предложить выбор", "не выполнять автоматически"], { fill: "#f5f3ff", stroke: "#c4b5fd", size: 16 }),
      box(460, 555, 260, 95, ["Подтверждение", "только после success", "на backend"], { fill: "#ecfeff", stroke: "#67e8f9", size: 16 }),
      arrow(590, 155, 590, 210, ""),
      arrow(430, 255, 250, 370, "нет"),
      arrow(590, 300, 590, 370, "да"),
      arrow(750, 255, 930, 370, "низкая уверенность"),
      arrow(590, 470, 590, 555, ""),
    ].join("\n"),
  },
  {
    file: "06-ui.html",
    title: "Структура пользовательского интерфейса",
    body: [
      box(80, 110, 220, 430, ["Sidebar", "навигация", "папки", "профиль"], { fill: "#eff6ff", stroke: "#93c5fd" }),
      box(360, 110, 700, 90, ["Верхняя область", "заголовок текущего раздела, фильтры, основные действия"], { fill: "#f8fafc", stroke: "#94a3b8", size: 16 }),
      box(360, 235, 700, 220, ["Рабочая область", "чат, карточки файлов, заметок, списков и напоминаний", "единый стиль карточек и действий"], { fill: "#f0fdf4", stroke: "#86efac", size: 16 }),
      box(360, 490, 700, 80, ["Нижняя панель чата", "ввод сообщения, выбор команды, вложения, отправка"], { fill: "#fff7ed", stroke: "#fdba74", size: 16 }),
      arrow(300, 320, 360, 320, "выбор раздела"),
      text(190, 585, ["На мобильном экране боковая панель", "заменяется компактным меню"], { size: 15, fill: "#475569" }),
    ].join("\n"),
  },
];

await mkdir(outDir, { recursive: true });
await mkdir(svgDir, { recursive: true });
for (const diagram of diagrams) {
  await writeFile(new URL(diagram.file, outDir), page(diagram.title, diagram.body, diagram.height), "utf8");
  await writeFile(
    new URL(diagram.file.replace(".html", ".svg"), svgDir),
    svgPage(diagram.title, diagram.body, diagram.height),
    "utf8",
  );
}

console.log(`Generated ${diagrams.length} diagram HTML/SVG files`);
