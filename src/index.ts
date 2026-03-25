#!/usr/bin/env node

/**
 * doordash-mcp — DoorDash MCP server (fully browserless).
 *
 * Supports two transport modes:
 *   - stdio (default): `node dist/index.js`
 *   - HTTP:            `PORT=3000 node dist/index.js`
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";

import { CookieJar } from "./client/cookies.js";
import { HttpClient } from "./client/http.js";
import { DoorDashSession } from "./client/session.js";
import { TrafficLogger } from "./logging/traffic.js";
import { LoginFlow } from "./auth/login.js";
import { GraphQLClient } from "./api/graphql.js";
import { SearchAPI } from "./api/search.js";
import { MenuAPI } from "./api/menu.js";
import { CartAPI } from "./api/cart.js";
import { CheckoutAPI } from "./api/checkout.js";
import { AccountAPI } from "./api/account.js";
import { OrdersAPI } from "./api/orders.js";
import { GroupAPI } from "./api/group.js";
import { registerTools, type APIs } from "./tools/index.js";

const log = (msg: string) => process.stderr.write(`[dd-mcp] ${msg}\n`);

/** Create a fully wired DoorDash client with all API modules. */
async function createClient(configDir?: string) {
  const session = new DoorDashSession(configDir);
  session.load();

  const logsDir = join(session.configDir, "logs");
  const logger = new TrafficLogger(logsDir);
  log(`traffic logs: ${logger.getSessionDir()}`);

  const http = new HttpClient(session.cookieJar, logger);
  await http.init();

  const gql = new GraphQLClient(http, session);
  const loginFlow = new LoginFlow(http, session);

  const apis: APIs = {
    login: loginFlow,
    search: new SearchAPI(gql),
    menu: new MenuAPI(gql),
    cart: new CartAPI(gql),
    checkout: new CheckoutAPI(gql, session),
    account: new AccountAPI(gql, http),
    orders: new OrdersAPI(gql),
    group: new GroupAPI(gql),
  };

  return { session, http, apis };
}

function createMcpServer(apis: APIs): McpServer {
  const server = new McpServer({
    name: "doordash-mcp",
    version: "0.1.0",
  });
  registerTools(server, apis);
  return server;
}

// ── Shutdown handling ────────────────────────────────────

let httpClient: HttpClient | null = null;

async function cleanup() {
  if (httpClient) {
    await httpClient.close().catch(() => {});
    httpClient = null;
  }
}

process.on("SIGTERM", () => cleanup().finally(() => process.exit(0)));
process.on("SIGINT", () => cleanup().finally(() => process.exit(0)));
process.on("beforeExit", () => { cleanup(); });

// ── Main ─────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "");

if (PORT) {
  // HTTP transport — hosted mode
  const { http, apis } = await createClient();
  httpClient = http;

  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: McpServer }
  >();

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname !== "/mcp") {
      res.writeHead(404).end("doordash-mcp — POST /mcp");
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "GET" || req.method === "DELETE") {
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(404).end("Session not found");
        return;
      }
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
      return;
    }

    if (req.method === "POST") {
      // Read body
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());

      // Existing session
      if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.transport.handleRequest(req, res, body);
        return;
      }

      // New session
      const mcpServer = createMcpServer(apis);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server: mcpServer });
          log(`session created: ${id}`);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          log(`session closed: ${transport.sessionId}`);
        }
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    res.writeHead(405).end("Method not allowed");
  });

  httpServer.listen(PORT, () => {
    log(`HTTP transport listening on port ${PORT}`);
    log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  });
} else {
  // stdio transport — local mode
  const { http, apis } = await createClient();
  httpClient = http;

  const server = createMcpServer(apis);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
