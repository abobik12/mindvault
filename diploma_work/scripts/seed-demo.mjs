import { mkdir, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

const API = "http://localhost:8080/api";
const outDir = new URL("../", import.meta.url);

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${options.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function readSse(response) {
  if (!response.ok) {
    throw new Error(`SSE request failed: ${response.status} ${await response.text()}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const line = chunk.split("\n").find((entry) => entry.startsWith("data: "));
      if (!line) continue;
      const payload = JSON.parse(line.slice(6));
      if (payload.content) text += payload.content;
    }
  }

  return text;
}

function listContent(items) {
  return JSON.stringify({
    kind: "todo-list",
    items: items.map((text, index) => ({
      id: `demo-${Date.now()}-${index}`,
      text,
      done: false,
    })),
  });
}

async function main() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const email = `demo-rac-${stamp}@mindvault.local`;
  const password = "Demo12345!";

  const registered = await request("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      email,
      password,
      fullName: "Рачинский Иван Александрович",
    }),
  });
  const token = registered.token;

  const folder = await request("/folders", {
    method: "POST",
    token,
    body: JSON.stringify({
      name: "Учебные материалы",
      color: "#2563eb",
      icon: "folder",
    }),
  });

  const note = await request("/items", {
    method: "POST",
    token,
    body: JSON.stringify({
      type: "note",
      title: "Идея ВКР",
      content:
        "Личный секретарь должен принимать быстрые сообщения, файлы и напоминания в одном интерфейсе. Для MVP важно не заменять все сервисы, а связать основные личные материалы с ассистентом.",
      folderId: folder.id,
    }),
  });

  const list = await request("/items", {
    method: "POST",
    token,
    body: JSON.stringify({
      type: "list",
      title: "Подготовка к защите",
      content: listContent([
        "проверить титульный лист",
        "обновить скриншоты интерфейса",
        "собрать PDF для проверки",
        "подготовить демонстрационный сценарий",
      ]),
      folderId: folder.id,
    }),
  });

  const reminder = await request("/items", {
    method: "POST",
    token,
    body: JSON.stringify({
      type: "reminder",
      title: "Проверить финальную версию диплома",
      content: "Перед сдачей открыть DOCX и PDF, проверить таблицы, рисунки и оглавление.",
      folderId: folder.id,
      reminderAt: "2026-05-25T10:00:00+03:00",
    }),
  });

  const fileText = [
    "MindVault demonstration file",
    "",
    "Файл используется для проверки загрузки, хранения и передачи контекста ассистенту.",
    "В MVP текстовые файлы сохраняются в базе данных и могут использоваться как источник для ответа.",
  ].join("\n");
  const fileData = Buffer.from(fileText, "utf8").toString("base64");
  const file = await request("/items/upload", {
    method: "POST",
    token,
    body: JSON.stringify({
      filename: "mindvault-demo.txt",
      mimeType: "text/plain",
      fileData,
      fileSize: Buffer.byteLength(fileText, "utf8"),
      folderId: folder.id,
    }),
  });

  const conversation = await request("/gemini/conversations/default", { token });
  const assistantResponse = await readSse(
    await fetch(`${API}/gemini/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        content: "Объясни, зачем в проекте нужен единый чатовый интерфейс. Используй сохраненные материалы.",
        attachments: [{ id: file.id }],
      }),
    }),
  );

  const session = {
    baseUrl: "http://localhost:18174",
    apiUrl: API,
    email,
    password,
    token,
    folder,
    note,
    list,
    reminder,
    file,
    conversationId: conversation.id,
    assistantResponsePreview: assistantResponse.slice(0, 1000),
    createdAt: new Date().toISOString(),
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(new URL("../demo-session.json", import.meta.url), JSON.stringify(session, null, 2), "utf8");
  console.log(JSON.stringify({
    email,
    folderId: folder.id,
    noteId: note.id,
    listId: list.id,
    reminderId: reminder.id,
    fileId: file.id,
    conversationId: conversation.id,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
