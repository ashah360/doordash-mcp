/**
 * Per-session traffic logger. Each request/response pair is written
 * to its own numbered JSON file in a timestamped session directory.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TrafficEntry {
  timestamp: string;
  duration_ms: number;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: {
    status: number;
    headers: Record<string, string | string[]>;
    body: unknown;
  };
}

/** Values to redact from logged headers and bodies. */
const REDACT_PATTERNS = [
  /ddweb_token=[^;]*/g,
  /csrf_token=[^;]*/g,
  /"password"\s*:\s*"[^"]*"/g,
];

function redact(s: string): string {
  let result = s;
  for (const pattern of REDACT_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const eqIdx = match.indexOf("=");
      const colonIdx = match.indexOf(":");
      if (eqIdx > 0) return match.slice(0, eqIdx + 1) + "[REDACTED]";
      if (colonIdx > 0) return match.slice(0, colonIdx) + ': "[REDACTED]"';
      return "[REDACTED]";
    });
  }
  return result;
}

export class TrafficLogger {
  private sessionDir: string;
  private counter = 0;

  constructor(baseDir: string) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.sessionDir = join(baseDir, ts);
    mkdirSync(this.sessionDir, { recursive: true });
  }

  /** Log a request/response pair to a numbered file. */
  log(entry: TrafficEntry): void {
    this.counter++;

    const num = String(this.counter).padStart(3, "0");
    const method = entry.request.method;
    const urlObj = safeParseUrl(entry.request.url);
    const host = urlObj?.hostname ?? "unknown";
    const path = urlObj?.pathname?.split("/").pop() ?? "";
    const filename = `${num}-${method}-${host}-${path}.json`.replace(
      /[^a-zA-Z0-9._-]/g,
      "_",
    );

    const serialized = redact(JSON.stringify(entry, null, 2));

    try {
      writeFileSync(join(this.sessionDir, filename), serialized);
    } catch (e) {
      // Don't let logging failures break the app
      process.stderr.write(
        `[traffic] failed to write ${filename}: ${(e as Error).message}\n`,
      );
    }
  }

  /** Return the session log directory path. */
  getSessionDir(): string {
    return this.sessionDir;
  }
}

function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
