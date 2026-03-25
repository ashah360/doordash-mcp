/**
 * HTTP client wrapping CycleTLS to spoof a Chrome JA3 TLS fingerprint,
 * allowing requests to pass through Cloudflare bot detection.
 * Handles cookie persistence, request/response logging, and body serialization.
 */

import initCycleTLS from "cycletls";
import type { CookieJar } from "./cookies.js";
import type { TrafficLogger } from "../logging/traffic.js";

const CHROME_JA3 =
  "771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513-21,29-23-24,0";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export interface HttpResponse {
  status: number;
  body: unknown;
  headers: Record<string, string | string[]>;
  json(): unknown;
  text(): string;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  disableRedirect?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CycleTLSInstance = any;

export class HttpClient {
  private tls: CycleTLSInstance = null;
  private jar: CookieJar;
  private logger: TrafficLogger | null;

  constructor(jar: CookieJar, logger?: TrafficLogger) {
    this.jar = jar;
    this.logger = logger ?? null;
  }

  async init(): Promise<this> {
    this.tls = await (initCycleTLS as any)();
    return this;
  }

  async request(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    if (!this.tls) throw new Error("HttpClient not initialized. Call init().");

    const method = (opts.method ?? "GET").toLowerCase();
    const cookieHeader = this.jar.getCookiesFor(url);

    const headers: Record<string, string> = {
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity",
      ...(opts.headers ?? {}),
    };

    if (cookieHeader) {
      headers["Cookie"] = cookieHeader;
    }

    let bodyStr: string | undefined;
    if (opts.body != null) {
      if (typeof opts.body === "object") {
        bodyStr = JSON.stringify(opts.body);
        headers["Content-Type"] ??= "application/json";
      } else {
        bodyStr = String(opts.body);
      }
    }

    const requestOpts: Record<string, unknown> = {
      ja3: CHROME_JA3,
      userAgent: USER_AGENT,
      headers,
      disableRedirect: opts.disableRedirect ?? false,
    };
    if (bodyStr) requestOpts.body = bodyStr;

    const start = Date.now();
    const resp = await (this.tls as any)(url, requestOpts, method);
    const duration = Date.now() - start;

    // Store cookies from response
    this.jar.storeCookies(url, resp.headers ?? {});

    let body: unknown = resp.body ?? resp.data ?? "";
    if (Buffer.isBuffer(body)) body = (body as Buffer).toString("utf-8");

    if (this.logger) {
      this.logger.log({
        timestamp: new Date().toISOString(),
        duration_ms: duration,
        request: {
          method: method.toUpperCase(),
          url,
          headers: { ...headers },
          body: opts.body ?? null,
        },
        response: {
          status: resp.status,
          headers: resp.headers ?? {},
          body,
        },
      });
    }

    return {
      status: resp.status,
      body,
      headers: resp.headers ?? {},
      json() {
        if (typeof body === "object" && body !== null) return body;
        if (typeof body === "string" && body) return JSON.parse(body);
        return null;
      },
      text() {
        if (typeof body === "string") return body;
        if (typeof body === "object") return JSON.stringify(body);
        return String(body);
      },
    };
  }

  async get(
    url: string,
    opts: Omit<RequestOptions, "method"> = {},
  ): Promise<HttpResponse> {
    return this.request(url, { ...opts, method: "GET" });
  }

  async post(
    url: string,
    body: unknown,
    opts: Omit<RequestOptions, "method" | "body"> = {},
  ): Promise<HttpResponse> {
    return this.request(url, {
      ...opts,
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(opts.headers ?? {}),
      },
    });
  }

  async close(): Promise<void> {
    if (this.tls) {
      try {
        await (this.tls as any).exit();
      } catch {}
      this.tls = null;
    }
  }
}
