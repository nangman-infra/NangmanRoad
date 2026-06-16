import { spawn } from "node:child_process";

const commands = [
  ["api", "npm", ["run", "dev:api"]],
  ["web", "npm", ["run", "dev:web"]]
];

const children = commands.map(([label, command, args]) => {
  const child = spawn(command, args, {
    stdio: ["inherit", "pipe", "pipe"],
    shell: process.platform === "win32"
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
  });

  child.on("exit", (code) => {
    if (code && code !== 0) {
      process.exitCode = code;
      stopAll();
    }
  });

  return child;
});

function stopAll() {
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
}

process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});

process.on("SIGTERM", () => {
  stopAll();
  process.exit(143);
});
