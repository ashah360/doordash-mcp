/**
 * Session lifecycle — persist/restore cookies and auth state to disk.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CookieJar } from "./cookies.js";

export interface SessionContext {
  readonly cookieJar: CookieJar;
  isAuthenticated(): boolean;
  getCsrfToken(): string;
}

export interface DoorDashConfig {
  email: string;
  password: string;
}

interface SessionData {
  cookies: ReturnType<CookieJar["toJSON"]>;
  state: Record<string, unknown>;
}

export class DoorDashSession {
  readonly configDir: string;
  readonly cookieJar: CookieJar;
  private state: Record<string, unknown> = {};

  constructor(configDir?: string) {
    this.configDir =
      configDir ?? join(process.env.HOME ?? "~", ".doordash-mcp");
    this.cookieJar = new CookieJar();
    mkdirSync(this.configDir, { recursive: true });
  }

  /** Load saved session (cookies + state) from disk. */
  load(): void {
    const path = this.sessionPath();
    try {
      if (existsSync(path)) {
        const raw = readFileSync(path, "utf-8");
        const data: SessionData = JSON.parse(raw);
        if (data.cookies) this.cookieJar.fromJSON(data.cookies);
        if (data.state) this.state = data.state;
      }
    } catch {}
  }

  /** Save session (cookies + state) to disk. */
  save(): void {
    const data: SessionData = {
      cookies: this.cookieJar.toJSON(),
      state: this.state,
    };
    try {
      writeFileSync(this.sessionPath(), JSON.stringify(data, null, 2));
    } catch (e) {
      process.stderr.write(
        `[session] failed to save: ${(e as Error).message}\n`,
      );
    }
  }

  /** Clear all session data. */
  clear(): void {
    this.cookieJar.clear();
    this.state = {};
    this.save();
  }

  /** Check if we have valid auth cookies. */
  isAuthenticated(): boolean {
    return !!this.cookieJar.get("ddweb_token");
  }

  /** Get the consumer ID from cookies. */
  getConsumerId(): string {
    return (
      this.cookieJar.get("ajs_user_id") ||
      this.cookieJar.get("consumerId") ||
      ""
    );
  }

  /** Get the CSRF token from cookies. */
  getCsrfToken(): string {
    return this.cookieJar.get("csrf_token") || "";
  }

  /** Get a state value. */
  getState<T = unknown>(key: string): T | undefined {
    return this.state[key] as T | undefined;
  }

  /** Set a state value. */
  setState(key: string, value: unknown): void {
    this.state[key] = value;
  }

  /** Read config from ~/.doordash-mcp/config.json */
  getConfig(): DoorDashConfig {
    const configPath = join(this.configDir, "config.json");
    try {
      const raw = readFileSync(configPath, "utf-8");
      const data = JSON.parse(raw);
      return {
        email: data?.doordash?.email ?? "",
        password: data?.doordash?.password ?? "",
      };
    } catch {
      return { email: "", password: "" };
    }
  }

  /** Debug: dump cookie names per domain. */
  debugCookies(): Record<string, string[]> {
    return this.cookieJar.dump();
  }

  private sessionPath(): string {
    return join(this.configDir, "session.json");
  }
}
