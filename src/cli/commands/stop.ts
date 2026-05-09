import { execSync } from "node:child_process";

export interface StopOptions {
  port: number;
}

export function stopViewer(options: StopOptions): void {
  const { port } = options;

  try {
    if (process.platform === "win32") {
      const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      if (!output) {
        process.stderr.write(`No process found listening on port ${port}.\n`);
        return;
      }

      const pids = new Set(
        output
          .split("\n")
          .map((line) => line.trim().split(/\s+/).pop()!)
          .filter(Boolean),
      );

      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F`, { stdio: ["pipe", "pipe", "pipe"] });
          process.stderr.write(`Stopped process ${pid} on port ${port}.\n`);
        } catch {
          process.stderr.write(`Failed to kill process ${pid}.\n`);
        }
      }
    } else {
      const output = execSync(`lsof -ti :${port}`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      if (!output) {
        process.stderr.write(`No process found listening on port ${port}.\n`);
        return;
      }

      const pids = output.split("\n").filter(Boolean);
      for (const pid of pids) {
        try {
          execSync(`kill -9 ${pid}`, { stdio: ["pipe", "pipe", "pipe"] });
          process.stderr.write(`Stopped process ${pid} on port ${port}.\n`);
        } catch {
          process.stderr.write(`Failed to kill process ${pid}.\n`);
        }
      }
    }
  } catch {
    process.stderr.write(`No process found listening on port ${port}.\n`);
  }
}
