async function main() {
const base = "http://localhost:8080/api";
const email = "student.mindvault@example.com";
const password = "MindVault2026";

async function req(path, opts = {}) {
  const res = await fetch(base + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} ${res.status}: ${text}`);
  return data;
}

let auth;
try {
  auth = await req("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, fullName: "Иван Рачинский" }),
  });
} catch {
  auth = await req("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

const headers = { Authorization: `Bearer ${auth.token}` };
const authed = (path, opts = {}) => req(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });

await authed("/auth/me/profile", {
  method: "PATCH",
  body: JSON.stringify({ fullName: "Иван Рачинский", avatarUrl: null }),
});

for (const item of await authed("/items?limit=300")) {
  await authed(`/items/${item.id}`, { method: "DELETE" }).catch(() => {});
}
for (const folder of await authed("/folders")) {
  if (!folder.isSystem) await authed(`/folders/${folder.id}`, { method: "DELETE" }).catch(() => {});
}

const folderDefs = [
  ["ВКР", "#2563eb", "GraduationCap"],
  ["Учебные материалы", "#16a34a", "BookOpen"],
  ["Рабочие задачи", "#64748b", "Briefcase"],
];
const folders = {};
for (const [name, color, icon] of folderDefs) {
  folders[name] = await authed("/folders", {
    method: "POST",
    body: JSON.stringify({ name, color, icon }),
  });
}

async function item(data) {
  return authed("/items", { method: "POST", body: JSON.stringify(data) });
}

await item({
  type: "note",
  title: "План подготовки иллюстраций для ВКР",
  folderId: folders["ВКР"].id,
  content:
    "Для документа нужны схемы архитектуры, базы данных, обработки сообщения, работы ИИ-ассистента и загрузки файла. Скриншоты интерфейса необходимо делать после заполнения приложения демонстрационными данными.",
});
await item({
  type: "note",
  title: "Требования к MindVault",
  folderId: folders["ВКР"].id,
  content:
    "Приложение должно хранить заметки, файлы, напоминания и списки в одной рабочей области. Пользователь взаимодействует с системой через веб-интерфейс и чат с ассистентом.",
});
await item({
  type: "note",
  title: "Конспект по базам данных",
  folderId: folders["Учебные материалы"].id,
  content:
    "В проекте используются таблицы users, folders, items, conversations и messages. Связи между таблицами позволяют хранить пользовательские данные изолированно для каждого аккаунта.",
});
await item({
  type: "note",
  title: "Проверка перед демонстрацией",
  folderId: folders["Рабочие задачи"].id,
  content:
    "Перед демонстрацией нужно запустить контейнеры, проверить состояние backend и frontend, выполнить тесты command-parser и TypeScript-проверку.",
});

function listContent(entries) {
  return JSON.stringify({
    kind: "todo-list",
    items: entries.map((text, i) => ({ id: `item-${Date.now()}-${i}`, text, done: i === 1 })),
  });
}

await item({
  type: "list",
  title: "Подготовка материалов ВКР",
  folderId: folders["ВКР"].id,
  content: listContent([
    "Проверить структуру глав",
    "Вставить схемы 1-6",
    "Сделать скриншоты интерфейса",
    "Обновить список рисунков",
    "Проверить подписи таблиц и рисунков",
  ]),
});
await item({
  type: "list",
  title: "Проверка проекта MindVault",
  folderId: folders["Рабочие задачи"].id,
  content: listContent([
    "Запустить Docker Compose",
    "Проверить контейнеры web, api и db",
    "Выполнить backend tests",
    "Выполнить backend typecheck",
    "Выполнить frontend typecheck",
  ]),
});

const today = new Date();
function future(days, h, m) {
  const d = new Date(today);
  d.setDate(d.getDate() + days);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

await item({ type: "reminder", title: "Проверить подписи рисунков", folderId: folders["ВКР"].id, reminderAt: future(1, 10, 0) });
await item({ type: "reminder", title: "Перенести скриншоты в Word", folderId: folders["ВКР"].id, reminderAt: future(1, 14, 0) });
await item({
  type: "reminder",
  title: "Повторно выполнить тесты перед защитой",
  folderId: folders["Рабочие задачи"].id,
  reminderAt: future(3, 11, 30),
});

async function upload(filename, mimeType, content, folderId) {
  const fileData = Buffer.from(content, "utf8").toString("base64");
  return authed("/items/upload", {
    method: "POST",
    body: JSON.stringify({ filename, mimeType, fileData, fileSize: Buffer.byteLength(content), folderId }),
  });
}

await upload(
  "mindvault_requirements.txt",
  "text/plain",
  "MindVault хранит заметки, файлы, напоминания и списки. Основной сценарий работы связан с добавлением и поиском персональной информации через единый интерфейс.",
  folders["ВКР"].id,
);
await upload(
  "testing_checklist.md",
  "text/markdown",
  "# Проверка MindVault\n\n- Запуск Docker Compose\n- Проверка контейнеров web, api, db\n- Backend tests\n- Backend typecheck\n- Frontend typecheck",
  folders["Рабочие задачи"].id,
);
await upload(
  "database_overview.json",
  "application/json",
  JSON.stringify(
    {
      project: "MindVault",
      tables: ["users", "folders", "items", "conversations", "messages"],
      note: "Универсальная таблица items используется для заметок, файлов, напоминаний и списков.",
    },
    null,
    2,
  ),
  folders["Учебные материалы"].id,
);

const conversation = await authed("/gemini/conversations", {
  method: "POST",
  body: JSON.stringify({ title: "Демонстрация работы ассистента" }),
});

console.log(JSON.stringify({ email, token: auth.token, conversationId: conversation.id }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
