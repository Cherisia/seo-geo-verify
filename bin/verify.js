#!/usr/bin/env node
// 어느 경로에서든 `verify <도메인>`으로 실행하기 위한 진입점 (npm link 로 전역 등록).
// 이 파일 위치 기준으로 tsx 와 src/cli.ts 를 찾으므로 현재 폴더와 상관없이 동작한다.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = import.meta.resolve("tsx");
const child = spawn(process.execPath, ["--import", tsx, path.join(root, "src", "cli.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
});
// Ctrl+C 는 자식(cli)이 받아서 정리하도록 둔다
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
