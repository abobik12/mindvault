const fs = require("fs/promises");
const path = require("path");
const { spawn, execSync } = require("child_process");
const WebSocket = require("../node_modules/.pnpm/ws@8.20.0/node_modules/ws");

const root = "D:/Univer/AI-Workspace-Hub";
const outDir = path.join(root, "vkr_assets", "final_screenshots");
const chromePath = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const baseUrl = "http://localhost:18174";
const apiUrl = "http://localhost:8080/api";
const email = "student.mindvault@example.com";
const password = "MindVault2026";

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loginToken() {
  const res = await fetch(`${apiUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  return (await res.json()).token;
}

function commandOutput(command) {
  try {
    return `> ${command}\n` + execSync(command, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout) : "";
    const stderr = error.stderr ? String(error.stderr) : "";
    return `> ${command}\n${stdout}${stderr}\nExit code: ${error.status ?? "unknown"}`;
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = this.id++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

async function connectPage(port) {
  let target;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/new`, { method: "PUT" });
      target = await res.json();
      break;
    } catch {
      await delay(500);
    }
  }
  if (!target?.webSocketDebuggerUrl) throw new Error("Chrome DevTools target was not created");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const cdp = new Cdp(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  return { cdp, ws };
}

async function setViewport(cdp, width, height, mobile = false, scale = 1) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: scale,
    mobile,
  });
}

async function navigate(cdp, url, waitMs = 2500) {
  await cdp.send("Page.navigate", { url });
  await delay(waitMs);
  await cdp.send("Runtime.evaluate", {
    expression: "document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()",
    awaitPromise: true,
  }).catch(() => {});
  await delay(500);
}

async function screenshot(cdp, filename) {
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await fs.writeFile(path.join(outDir, filename), Buffer.from(result.data, "base64"));
}

function terminalHtml(title, body) {
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<style>
body { margin: 0; background: #f4f6f8; font-family: Consolas, "Courier New", monospace; color: #111827; }
.wrap { padding: 34px; }
.bar { background: #111827; color: #f9fafb; padding: 12px 18px; border-radius: 10px 10px 0 0; font: 16px Arial, sans-serif; }
pre { margin: 0; padding: 22px; background: #ffffff; border: 1px solid #d1d5db; border-top: 0; border-radius: 0 0 10px 10px; font-size: 18px; line-height: 1.45; white-space: pre-wrap; }
</style>
</head>
<body><div class="wrap"><div class="bar">${title}</div><pre>${escaped}</pre></div></body>
</html>`)}`;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const token = await loginToken();
  const port = 9333;
  const userDataDir = path.join(root, ".tmp_chrome_vkr");
  await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  const chrome = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--disable-gpu",
    "--hide-scrollbars",
    "--window-size=1366,768",
    "about:blank",
  ], { stdio: "ignore" });

  try {
    const { cdp, ws } = await connectPage(port);
    await setViewport(cdp, 1366, 768, false, 1);
    await navigate(cdp, `${baseUrl}/auth`, 2000);
    await cdp.send("Runtime.evaluate", {
      expression: `localStorage.setItem("mindvault_token", ${JSON.stringify(token)}); localStorage.removeItem("mindvault_pending_file_question");`,
    });

    const pages = [
      [`${baseUrl}/`, "fig07_main_page.png"],
      [`${baseUrl}/`, "fig08_ai_chat.png"],
      [`${baseUrl}/notes`, "fig09_notes.png"],
      [`${baseUrl}/files`, "fig10_files.png"],
      [`${baseUrl}/reminders`, "fig11_reminders.png"],
      [`${baseUrl}/lists`, "fig12_lists.png"],
    ];
    for (const [url, file] of pages) {
      await navigate(cdp, url, 3500);
      await screenshot(cdp, file);
    }

    await setViewport(cdp, 390, 845, true, 2);
    await navigate(cdp, `${baseUrl}/`, 3500);
    await screenshot(cdp, "fig13_mobile.png");

    await setViewport(cdp, 1366, 768, false, 1);
    const dockerText = commandOutput("docker compose ps");
    await navigate(cdp, terminalHtml("Результат запуска контейнеров Docker", dockerText), 1000);
    await screenshot(cdp, "fig14_docker.png");

    const testsText = [
      commandOutput("corepack pnpm --filter @workspace/api-server test"),
      commandOutput("corepack pnpm --filter @workspace/api-server run typecheck"),
      commandOutput("corepack pnpm --filter @workspace/mindvault run typecheck"),
    ].join("\n");
    await navigate(cdp, terminalHtml("Результат выполнения тестов", testsText), 1000);
    await screenshot(cdp, "fig15_tests.png");

    ws.close();
  } finally {
    chrome.kill();
    await delay(1000);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
