import { rmSync } from "node:fs";

for (const file of ["package-lock.json", "yarn.lock"]) {
  rmSync(file, { force: true });
}

const installer = `${process.env.npm_config_user_agent ?? ""} ${process.env.npm_execpath ?? ""}`;
if (!installer.toLowerCase().includes("pnpm")) {
  console.error("Use pnpm instead");
  process.exit(1);
}
