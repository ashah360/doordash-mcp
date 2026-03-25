# doordash-mcp

An MCP server that lets AI agents order food, groceries, and more through DoorDash. Search restaurants, browse menus, build carts, and place orders — all programmatically.

Built with [CycleTLS](https://github.com/Danny-Dasilva/CycleTLS), the [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk), and DoorDash's internal GraphQL API. No browser, Chromium, or Puppeteer/Playwright required.

## Setup

```bash
git clone https://github.com/ashah360/doordash-mcp.git
cd doordash-mcp
npm install
npm run build
```

Create a `.env` file (see `.env.example`):

```
DOORDASH_EMAIL=your@email.com
DOORDASH_PASSWORD=your-password
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "doordash": {
      "command": "node",
      "args": ["/path/to/doordash-mcp/dist/index.js"],
      "env": {
        "DOORDASH_EMAIL": "your@email.com",
        "DOORDASH_PASSWORD": "your-password"
      }
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "doordash": {
      "command": "node",
      "args": ["/path/to/doordash-mcp/dist/index.js"],
      "env": {
        "DOORDASH_EMAIL": "your@email.com",
        "DOORDASH_PASSWORD": "your-password"
      }
    }
  }
}
```

### HTTP transport

Set the `PORT` environment variable to start an HTTP server instead of stdio:

```bash
PORT=3000 node dist/index.js
```

The MCP endpoint will be available at `http://localhost:3000/mcp`.

## Tools

21 tools covering the full DoorDash lifecycle:

### Discovery

| Tool                          | Description                                                       |
| ----------------------------- | ----------------------------------------------------------------- |
| `doordash_search`             | Search restaurants and stores by name, cuisine, or food type      |
| `doordash_menu`               | Get a restaurant's full menu with items, prices, and option flags |
| `doordash_convenience_search` | Search items within grocery/convenience/alcohol stores            |
| `doordash_item_options`       | Get customization options for menu items (sides, extras, sizes)   |

### Cart

| Tool                   | Description                                         |
| ---------------------- | --------------------------------------------------- |
| `doordash_add_to_cart` | Add items to cart with nested customization options |
| `doordash_cart`        | View all active carts with items and subtotals      |
| `doordash_modify_cart` | Update item quantity or remove items                |
| `doordash_delete_cart` | Delete a cart                                       |

### Checkout

| Tool                    | Description                            |
| ----------------------- | -------------------------------------- |
| `doordash_checkout`     | Preview fees, delivery time, and total |
| `doordash_place_order`  | Place an order (charges the account)   |
| `doordash_order_status` | Check payment and delivery status      |

### Group Orders

| Tool                          | Description                                      |
| ----------------------------- | ------------------------------------------------ |
| `doordash_create_group_order` | Create a group order and get a share link        |
| `doordash_group_order_status` | View each person's items and finalization status |

### Account

| Tool                       | Description                               |
| -------------------------- | ----------------------------------------- |
| `doordash_login`           | Automated login with email + password     |
| `doordash_verify`          | Enter MFA verification code               |
| `doordash_orders`          | View order history                        |
| `doordash_addresses`       | List saved delivery addresses             |
| `doordash_set_address`     | Set active delivery address               |
| `doordash_add_address`     | Add a new delivery address                |
| `doordash_payment_methods` | List saved payment methods                |
| `doordash_add_card`        | Add a payment card (tokenized via Stripe) |

## How it works

DoorDash doesn't have a public consumer API. This project reverse-engineers their internal GraphQL API — the same one `doordash.com` uses in the browser.

The hard part is Cloudflare. DoorDash sits behind Cloudflare's bot detection, which fingerprints TLS handshakes (JA3). A normal `fetch()` from Node.js gets blocked instantly because its TLS fingerprint doesn't look like a real browser.

**CycleTLS** solves this by establishing TLS connections with a Chrome-like JA3 fingerprint at the network level. No browser needed — just a spoofed handshake. Combined with a matching User-Agent header, requests look indistinguishable from a real Chrome session to Cloudflare.

GraphQL queries were captured from real DoorDash browser sessions and are stored as `.graphql` files in `queries/`.

## Authentication

Login is fully automated — no manual browser step required.

1. The server calls DoorDash's identity endpoint with your email and password
2. If MFA is required, it prompts for a verification code via `doordash_verify`
3. Session cookies are persisted to `~/.doordash-mcp/session.json`
4. Subsequent starts restore the session from disk — no re-login needed until cookies expire

## Architecture

```
src/
├── index.ts              # MCP server bootstrap (stdio + HTTP transports)
├── tools/
│   └── index.ts          # 21 tool registrations
├── api/
│   ├── graphql.ts        # GraphQL client + query loader
│   ├── search.ts         # Restaurant/store search
│   ├── menu.ts           # Menus + item options
│   ├── cart.ts           # Cart management
│   ├── checkout.ts       # Checkout + order placement
│   ├── orders.ts         # Order history + status
│   ├── group.ts          # Group orders
│   └── account.ts        # Addresses, payment methods, Stripe tokenization
├── auth/
│   └── login.ts          # Login + MFA flow
├── client/
│   ├── http.ts           # CycleTLS HTTP client (JA3 spoofing)
│   ├── cookies.ts        # Cookie jar with domain matching + expiry
│   └── session.ts        # Session persistence to disk
└── logging/
    └── traffic.ts        # Request/response logging with redaction
queries/
└── *.graphql             # Captured GraphQL queries
```

## Known limitations

- **Real money**: `doordash_place_order` charges your account. There is no sandbox.
- **Cart quantity updates**: DoorDash's `updateCartItemV2` mutation is broken server-side. The tool works around it via remove + re-add.
- **Scheduled orders**: Only ASAP delivery is supported.
- **Address geocoding**: `doordash_add_address` requires lat/lng coordinates.
- **VCC cards**: Virtual credit cards are blocked by DoorDash's fraud detection.

## License

MIT
