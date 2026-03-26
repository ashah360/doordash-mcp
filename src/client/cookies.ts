/**
 * Cookie jar with domain matching, expiry tracking, and persistence.
 */

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number; // unix ms
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
}

export class CookieJar {
  /** domain → (cookie name → Cookie) */
  private store = new Map<string, Map<string, Cookie>>();

  /** Get the Cookie header string for a given URL. */
  getCookiesFor(url: string): string {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return "";
    }

    const now = Date.now();
    const pairs: string[] = [];

    for (const [domain, cookies] of this.store) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) {
        for (const [, cookie] of cookies) {
          // Skip expired cookies
          if (cookie.expires && cookie.expires < now) continue;
          pairs.push(`${cookie.name}=${cookie.value}`);
        }
      }
    }

    return pairs.join("; ");
  }

  /** Parse Set-Cookie headers from a response and merge into the jar. */
  storeCookies(url: string, headers: Record<string, string | string[]>): void {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return;
    }

    const raw =
      headers?.["Set-Cookie"] ??
      headers?.["set-cookie"] ??
      headers?.["SET-COOKIE"] ??
      null;
    if (!raw) return;

    const setCookies = this.normalizeSetCookieHeader(raw);

    for (const sc of setCookies) {
      const parts = sc.split(";").map((p) => p.trim());
      const nameVal = parts[0];
      if (!nameVal?.includes("=")) continue;

      const eqIdx = nameVal.indexOf("=");
      const name = nameVal.slice(0, eqIdx).trim();
      const value = nameVal.slice(eqIdx + 1).trim();

      if (!name) continue;

      // Skip deleted cookies
      if (value === "deleted" || value === "") {
        this.remove(hostname, name);
        continue;
      }

      // Parse directives
      let domain = hostname;
      let path = "/";
      let expires: number | undefined;
      let secure = false;
      let httpOnly = false;
      let sameSite: string | undefined;

      for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
        const lower = part.toLowerCase();

        if (lower.startsWith("domain=")) {
          domain = lower.slice(7).replace(/^\./, "");
        } else if (lower.startsWith("path=")) {
          path = part.slice(5);
        } else if (lower.startsWith("expires=")) {
          const dateStr = part.slice(8);
          const ms = Date.parse(dateStr);
          if (!isNaN(ms)) expires = ms;
        } else if (lower.startsWith("max-age=")) {
          const seconds = parseInt(lower.slice(8));
          if (!isNaN(seconds)) expires = Date.now() + seconds * 1000;
        } else if (lower === "secure") {
          secure = true;
        } else if (lower === "httponly") {
          httpOnly = true;
        } else if (lower.startsWith("samesite=")) {
          sameSite = part.slice(9);
        }
      }

      // Check if already expired
      if (expires && expires < Date.now()) {
        this.remove(domain, name);
        continue;
      }

      if (!this.store.has(domain)) {
        this.store.set(domain, new Map());
      }
      this.store.get(domain)!.set(name, {
        name,
        value,
        domain,
        path,
        expires,
        secure,
        httpOnly,
        sameSite,
      });
    }
  }

  /** Get a cookie value by name, searching all domains. */
  get(name: string): string {
    for (const cookies of this.store.values()) {
      const cookie = cookies.get(name);
      if (cookie) {
        if (cookie.expires && cookie.expires < Date.now()) continue;
        return cookie.value;
      }
    }
    return "";
  }

  /** Remove a cookie from a specific domain. */
  remove(domain: string, name: string): void {
    this.store.get(domain)?.delete(name);
  }

  /** Clear all cookies. */
  clear(): void {
    this.store.clear();
  }

  /** Serialize the jar for persistence. */
  toJSON(): Record<string, Cookie[]> {
    const result: Record<string, Cookie[]> = {};
    for (const [domain, cookies] of this.store) {
      result[domain] = [...cookies.values()];
    }
    return result;
  }

  /** Restore the jar from serialized data. */
  fromJSON(data: Record<string, Cookie[]>): void {
    this.store.clear();
    for (const [domain, cookies] of Object.entries(data)) {
      const map = new Map<string, Cookie>();
      for (const cookie of cookies) {
        map.set(cookie.name, cookie);
      }
      this.store.set(domain, map);
    }
  }

  /** Debug: list cookie names per domain. */
  dump(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [domain, cookies] of this.store) {
      result[domain] = [...cookies.keys()];
    }
    return result;
  }

  /** Normalize the Set-Cookie header into an array of individual cookie strings. */
  private normalizeSetCookieHeader(raw: string | string[] | unknown): string[] {
    if (Array.isArray(raw)) {
      return raw.flatMap((s) => {
        if (typeof s !== "string") return [];
        return this.splitSetCookieString(s);
      });
    }
    if (typeof raw === "string") {
      return this.splitSetCookieString(raw);
    }
    return [];
  }

  /**
   * Split a combined Set-Cookie string on commas that start a new cookie,
   * not commas inside date strings (e.g. "Expires=Thu, 01 Jan 1970").
   */
  private splitSetCookieString(s: string): string[] {
    return s.split(/,(?=\s*[a-zA-Z_][a-zA-Z0-9_-]*=)/);
  }
}
