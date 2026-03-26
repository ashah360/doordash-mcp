/**
 * GraphQL client for DoorDash API. Loads .graphql query files,
 * adds DD-specific headers, handles errors.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpClient } from "../client/http.js";
import type { SessionContext } from "../client/session.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUERIES_DIR = join(__dirname, "..", "..", "queries");

export class GraphQLError extends Error {
  constructor(
    public operation: string,
    message: string,
    public statusCode?: number,
  ) {
    super(`GraphQL ${operation}: ${message}`);
    this.name = "GraphQLError";
  }
}

export class AuthError extends Error {
  constructor() {
    super("Not logged into DoorDash. Run the doordash_login tool first.");
    this.name = "AuthError";
  }
}

export class GraphQLClient {
  constructor(
    private http: HttpClient,
    private session: SessionContext,
  ) {}

  /** Execute a GraphQL operation against DoorDash's API. */
  async query<T = unknown>(
    operation: string,
    variables: Record<string, unknown>,
    queryText: string,
  ): Promise<T> {
    if (!this.session.isAuthenticated()) {
      throw new AuthError();
    }

    const csrf = this.session.getCsrfToken();

    const resp = await this.http.post(
      `https://www.doordash.com/graphql/${operation}?operation=${operation}`,
      {
        operationName: operation,
        variables,
        query: queryText,
      },
      {
        headers: {
          Origin: "https://www.doordash.com",
          Referer: "https://www.doordash.com/",
          "x-csrftoken": csrf,
          "x-channel-id": "marketplace",
          "x-experience-id": "doordash",
          "apollographql-client-name":
            "@doordash/app-consumer-production-ssr-client",
          "apollographql-client-version": "3.0",
        },
        cookieJar: this.session.cookieJar,
      },
    );

    if (resp.status === 401 || resp.status === 403) {
      throw new AuthError();
    }

    const data = resp.json() as Record<string, unknown>;

    if (resp.status !== 200) {
      const msg = extractErrorMessage(data) ?? `HTTP ${resp.status}`;
      throw new GraphQLError(operation, msg, resp.status);
    }

    if (data?.errors && Array.isArray(data.errors) && data.errors.length > 0) {
      const msg = (data.errors as any[])
        .map((e: any) => e.message)
        .join("; ")
        .slice(0, 400);
      throw new GraphQLError(operation, msg);
    }

    return data.data as T;
  }

  /** Load a .graphql query file from the queries directory. Always reads from disk so edits take effect without restart. */
  loadQuery(filename: string): string {
    const filepath = join(QUERIES_DIR, filename);
    return readFileSync(filepath, "utf-8");
  }
}

function extractErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  if (Array.isArray(obj.errors) && obj.errors.length > 0) {
    return (obj.errors as any[])
      .map((e: any) => e.message)
      .join("; ")
      .slice(0, 400);
  }

  return null;
}
