/**
 * All 21 DoorDash MCP tool registrations.
 * Thin wrappers: parse MCP input → call API → format markdown output.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuthError } from "../api/graphql.js";
import type { SearchAPI } from "../api/search.js";
import type { MenuAPI } from "../api/menu.js";
import type { CartAPI } from "../api/cart.js";
import type { CheckoutAPI } from "../api/checkout.js";
import type { AccountAPI } from "../api/account.js";
import type { OrdersAPI } from "../api/orders.js";
import type { GroupAPI } from "../api/group.js";
import type { LoginFlow } from "../auth/login.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(msg: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: msg }] };
}

function wrap(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  return fn().catch((e) => {
    if (e instanceof AuthError) return err(e.message);
    return err(String((e as Error).message ?? e));
  });
}

/**
 * Build the nestedOptions tree for addCartItem.
 * Supports flat options: [{"id":"123","name":"Chicken"}]
 * And nested options: [{"id":"123","name":"Chicken","children":[{"id":"456","name":"Brown Rice"}]}]
 */
function buildNestedOption(o: any): any {
  const children = (o.children ?? []).map((c: any) => buildNestedOption(c));
  return {
    id: o.id,
    quantity: o.quantity ?? 1,
    options: children,
    itemExtraOption: {
      id: o.id,
      name: o.name,
      description: o.name,
      price: o.price ?? 0,
      chargeAbove: 0,
      defaultQuantity: 0,
    },
  };
}

/** Format an option group (and its nested sub-groups) as markdown. */
function formatOptionGroup(lines: string[], group: any, headingLevel: number): void {
  const hashes = "#".repeat(headingLevel);
  let constraint = group.required ? " **(required)**" : " (optional)";
  if (group.minOptions > 0 || group.maxOptions > 0) {
    constraint += ` [select ${group.minOptions > 0 ? `${group.minOptions}-` : "up to "}${group.maxOptions || "any"}]`;
  }
  lines.push(`${hashes} ${group.name}${constraint}`);
  for (const opt of group.options) {
    const price = opt.price > 0 ? ` ${opt.displayPrice}` : "";
    lines.push(`- **${opt.name}**${price} (option ID: ${opt.id})`);
    // Show nested sub-groups (e.g. toppings under a filling)
    for (const sg of opt.subGroups ?? []) {
      formatOptionGroup(lines, sg, Math.min(headingLevel + 1, 4));
    }
  }
  lines.push("");
}

export interface APIs {
  login: LoginFlow;
  search: SearchAPI;
  menu: MenuAPI;
  cart: CartAPI;
  checkout: CheckoutAPI;
  account: AccountAPI;
  orders: OrdersAPI;
  group: GroupAPI;
}

export function registerTools(server: McpServer, api: APIs): void {
  // ── Login ──────────────────────────────────────────────

  server.registerTool(
    "doordash_login",
    {
      description:
        "Log into DoorDash. Reads credentials from ~/.doordash-mcp/config.json. Returns success or requests MFA code.",
    },
    () =>
      wrap(async () => {
        const result = await api.login.login();
        if (result.status === "mfa_required") {
          await api.login.requestMfaCode("email");
          return ok(
            "Verification code sent to your email. Call doordash_verify with the code.",
          );
        }
        return result.status === "success"
          ? ok(result.message)
          : err(result.message);
      }),
  );

  server.registerTool(
    "doordash_verify",
    {
      description: "Complete DoorDash login with a verification code.",
      inputSchema: {
        code: z.string().describe("6-digit verification code"),
      },
    },
    ({ code }) =>
      wrap(async () => {
        const result = await api.login.verifyMfa(code);
        return result.status === "success"
          ? ok(result.message)
          : err(result.message);
      }),
  );

  // ── Search ─────────────────────────────────────────────

  server.registerTool(
    "doordash_search",
    {
      description: "Search for restaurants on DoorDash by name, cuisine, or food type",
      inputSchema: {
        query: z.string().describe("Search query (e.g. 'pizza', 'thai food', 'McDonalds')"),
      },
    },
    ({ query }) =>
      wrap(async () => {
        const stores = await api.search.searchStores(query);
        if (stores.length === 0) return ok(`No restaurants found for "${query}".`);

        const text = stores
          .map(
            (s, i) =>
              `${i + 1}. **${s.name}** — ${s.cuisine} (${s.distance}) [store ID: ${s.storeId}]`,
          )
          .join("\n");
        return ok(`Search results for "${query}":\n\n${text}`);
      }),
  );

  // ── Menu ───────────────────────────────────────────────

  server.registerTool(
    "doordash_menu",
    {
      description: "Get a restaurant's menu by store ID. Use doordash_search first to find the store ID.",
      inputSchema: {
        store_id: z.string().describe("DoorDash store ID (numeric)"),
      },
    },
    ({ store_id }) =>
      wrap(async () => {
        const menu = await api.menu.getStoreMenu(store_id);
        const lines: string[] = [];
        lines.push(`# ${menu.name}`);
        if (menu.description) lines.push(`*${menu.description}*`);
        if (menu.isConvenience) lines.push("**Type: Convenience store**");
        lines.push("");
        if (menu.rating) lines.push(`Rating: ${menu.rating}`);
        if (menu.deliveryMinutes) lines.push(`Delivery: ~${menu.deliveryMinutes} min`);
        if (menu.priceRange) lines.push(`Price: ${menu.priceRange}`);
        lines.push("");

        if (menu.isConvenience) {
          lines.push("This is a convenience store with a large catalog.");
          lines.push("Use `doordash_convenience_search` with this store ID to find specific items.");
          return ok(lines.join("\n"));
        }

        for (const cat of menu.categories) {
          lines.push(`## ${cat.name}`);
          for (const item of cat.items) {
            let line = `- **${item.name}** ${item.displayPrice}`;
            if (!item.quickAddEligible) line += " ⚙️";
            if (item.description) {
              const desc =
                item.description.length > 80
                  ? item.description.slice(0, 80) + "..."
                  : item.description;
              line += ` — ${desc}`;
            }
            line += ` (ID: ${item.id})`;
            lines.push(line);
          }
          lines.push("");
        }

        return ok(lines.join("\n"));
      }),
  );

  server.registerTool(
    "doordash_convenience_search",
    {
      description:
        "Search for items within a convenience store (grocery, alcohol, pharmacy, etc.).",
      inputSchema: {
        store_id: z.string().describe("DoorDash store ID"),
        query: z.string().describe("Search query (e.g. 'chicken breast', 'la croix')"),
      },
    },
    ({ store_id, query }) =>
      wrap(async () => {
        const items = await api.menu.searchConvenience(store_id, query);
        if (items.length === 0) return err(`No items found for "${query}" at this store.`);

        const lines = [`Search results for "${query}":\n`];
        for (const item of items) {
          lines.push(`- **${item.name}** ${item.price} (${item.subtext}) [ID: ${item.id}]`);
        }
        lines.push("\n*Use doordash_add_to_cart with store_id and item_id to add items.*");
        return ok(lines.join("\n"));
      }),
  );

  server.registerTool(
    "doordash_item_options",
    {
      description: "Get customization options for a menu item (sides, extras, modifications).",
      inputSchema: {
        store_id: z.string().describe("DoorDash store ID"),
        item_id: z.string().describe("Item ID from doordash_menu"),
      },
    },
    ({ store_id, item_id }) =>
      wrap(async () => {
        const details = await api.menu.getItemOptions(store_id, item_id);
        const lines: string[] = [];
        lines.push(`# ${details.name}`);
        if (details.description) lines.push(`*${details.description}*`);
        if (details.unitAmount) lines.push(`Base price: $${(details.unitAmount / 100).toFixed(2)}`);
        lines.push("");

        if (details.optionGroups.length === 0) {
          lines.push("No customization options. This item can be added directly.");
        }

        for (const group of details.optionGroups) {
          formatOptionGroup(lines, group, 2);
        }

        lines.push(
          "*To add with options, call doordash_add_to_cart with the `options` parameter.*",
        );
        return ok(lines.join("\n"));
      }),
  );

  // ── Cart ───────────────────────────────────────────────

  server.registerTool(
    "doordash_add_to_cart",
    {
      description:
        "Add an item to your DoorDash cart. For restaurants, pass item_name. For convenience stores, pass item_id directly.",
      inputSchema: {
        store_id: z.string().describe("DoorDash store ID"),
        item_name: z.string().describe("Item name (used for restaurant menu lookup)"),
        item_id: z.string().optional().describe("Item ID for convenience store items"),
        quantity: z.number().optional().default(1).describe("Quantity (default 1)"),
        options: z.string().optional().describe('JSON array of selected options. Flat: [{"id":"123","name":"Chicken"}]. Nested (for items like burritos where toppings go inside the filling): [{"id":"123","name":"Chicken","children":[{"id":"456","name":"Brown Rice"},{"id":"789","name":"Sour Cream"}]}]'),
        unit_price: z.number().optional().describe("Price in cents (for convenience store items)"),
        cart_id: z.string().optional().describe("Cart ID to add to"),
      },
    },
    ({ store_id, item_name, item_id, quantity, options, unit_price, cart_id }) =>
      wrap(async () => {
        let resolvedId = item_id ?? "";
        let resolvedName = item_name;
        let resolvedPrice = unit_price ?? 0;
        let menuId = "";
        let nestedOpts = "[]";

        if (!resolvedId) {
          // Restaurant flow: look up item from menu
          const menu = await api.menu.getStoreMenu(store_id);
          let found: any = null;
          const nameLower = item_name.toLowerCase();

          // Prefer exact match, then substring match
          for (const cat of menu.categories) {
            for (const item of cat.items) {
              if (item.name.toLowerCase() === nameLower) {
                found = item;
                break;
              }
            }
            if (found) break;
          }
          if (!found) {
            for (const cat of menu.categories) {
              for (const item of cat.items) {
                if (item.name.toLowerCase().includes(nameLower)) {
                  found = item;
                  break;
                }
              }
              if (found) break;
            }
          }

          if (!found) {
            const names = menu.categories
              .flatMap((c) => c.items.map((i) => i.name))
              .slice(0, 10);
            return err(`Item "${item_name}" not found. Try: ${names.join(", ")}`);
          }

          resolvedId = found.id;
          resolvedName = found.name;
          resolvedPrice = found.quickAddPrice;
          menuId = menu.menuId;
          nestedOpts = found.quickAddNestedOptions;
        }

        if (options) {
          nestedOpts = JSON.stringify(
            JSON.parse(options).map((o: any) => buildNestedOption(o)),
          );
        }

        const result = await api.cart.addToCart({
          storeId: store_id,
          itemId: resolvedId,
          itemName: resolvedName,
          menuId,
          quantity,
          nestedOptions: nestedOpts,
          unitPrice: resolvedPrice,
          cartId: cart_id,
        });

        const subtotal = `$${(result.subtotal / 100).toFixed(2)}`;
        const qtyNote =
          result.itemQuantity > quantity
            ? ` (cart now has ${result.itemQuantity}x total)`
            : "";
        return ok(
          `Added ${quantity}x **${resolvedName}**${qtyNote}. Subtotal: ${subtotal}. Cart ID: ${result.cartId}`,
        );
      }),
  );

  server.registerTool(
    "doordash_cart",
    { description: "View your current DoorDash cart contents and totals" },
    () =>
      wrap(async () => {
        const carts = await api.cart.listCarts();
        if (carts.length === 0) return err("Cart is empty.");

        const lines = ["# Your Carts\n"];
        for (const cart of carts) {
          const group = cart.isGroupOrder ? " (GROUP ORDER)" : "";
          lines.push(`**${cart.storeName}**${group}`);
          lines.push(`Cart ID: ${cart.id}`);
          for (const item of cart.items) {
            const price = item.price ? `$${(item.price / 100).toFixed(2)}` : "";
            lines.push(`- ${item.quantity}x **${item.name}** ${price} (item ID: ${item.id})`);
          }
          if (cart.subtotal) lines.push(`\nSubtotal: $${(cart.subtotal / 100).toFixed(2)}`);
          lines.push("");
        }
        return ok(lines.join("\n"));
      }),
  );

  server.registerTool(
    "doordash_modify_cart",
    {
      description: "Modify cart: change item quantity or remove items.",
      inputSchema: {
        cart_id: z.string().describe("Cart ID"),
        item_id: z.string().describe("Item ID from doordash_cart"),
        action: z.enum(["update_quantity", "remove"]).describe("Action to perform"),
        quantity: z.number().optional().describe("New quantity (for update_quantity)"),
        store_id: z.string().optional().describe("Store ID (auto-detected if not specified)"),
      },
    },
    ({ cart_id, item_id, action, quantity, store_id }) =>
      wrap(async () => {
        if (action === "remove") {
          await api.cart.removeItem(cart_id, item_id);
          const carts = await api.cart.listCarts();
          const remaining = carts.find((c) => c.id === cart_id)?.items.length ?? 0;
          return ok(`Item removed. ${remaining} items remaining in cart.`);
        }

        if (action === "update_quantity") {
          if (!quantity || quantity < 1) return err("Quantity must be at least 1.");

          const carts = await api.cart.listCarts();
          const targetCart = carts.find((c) => c.id === cart_id);
          const targetItem = targetCart?.items.find((i) => i.id === item_id);
          if (!targetItem) return err("Item not found in cart.");

          const sid = store_id ?? targetCart?.storeId ?? "";

          // Remove then re-add (updateCartItemV2 is broken)
          await api.cart.removeItem(cart_id, item_id);
          try {
            const result = await api.cart.addToCart({
              storeId: sid,
              itemId: targetItem.menuItemId,
              itemName: targetItem.name,
              quantity,
              nestedOptions: targetItem.nestedOptions
                ? JSON.stringify(targetItem.nestedOptions)
                : "[]",
              unitPrice: targetItem.price,
              cartId: cart_id,
              specialInstructions: targetItem.specialInstructions,
            });
            return ok(
              `Updated **${targetItem.name}** to ${quantity}x. Subtotal: $${(result.subtotal / 100).toFixed(2)}. Cart ID: ${result.cartId}`,
            );
          } catch {
            // Cart may have been deleted when last item removed — retry without cartId
            const result = await api.cart.addToCart({
              storeId: sid,
              itemId: targetItem.menuItemId,
              itemName: targetItem.name,
              quantity,
              nestedOptions: targetItem.nestedOptions
                ? JSON.stringify(targetItem.nestedOptions)
                : "[]",
              unitPrice: targetItem.price,
              cartId: "",
              specialInstructions: targetItem.specialInstructions,
            });
            return ok(
              `Updated **${targetItem.name}** to ${quantity}x. Subtotal: $${(result.subtotal / 100).toFixed(2)}. Cart ID: ${result.cartId}`,
            );
          }
        }

        return err(`Unknown action: ${action}`);
      }),
  );

  server.registerTool(
    "doordash_delete_cart",
    {
      description: "Delete a cart.",
      inputSchema: { cart_id: z.string().describe("Cart ID to delete") },
    },
    ({ cart_id }) =>
      wrap(async () => {
        await api.cart.deleteCart(cart_id);
        return ok(`Cart ${cart_id} deleted.`);
      }),
  );

  // ── Checkout ───────────────────────────────────────────

  server.registerTool(
    "doordash_checkout",
    {
      description: "Preview checkout details (fees, total). Does NOT place the order.",
      inputSchema: {
        cart_id: z.string().optional().describe("Cart ID. Uses most recent if not specified."),
      },
    },
    ({ cart_id }) =>
      wrap(async () => {
        let cartId = cart_id ?? "";
        let storeName = "Unknown";

        if (!cartId) {
          const carts = await api.cart.listCarts();
          if (carts.length === 0) return err("Cart is empty.");
          cartId = carts[0].id;
          storeName = carts[0].storeName;
        }

        const summary = await api.checkout.getFeeTally(cartId);
        const lines = [`# Checkout: ${storeName}\n`];
        for (const item of summary.lineItems) {
          lines.push(`- ${item.label}: ${item.amount}`);
        }
        if (summary.total) lines.push(`\n**Total: ${summary.total}**`);
        lines.push(`\nCart ID: ${cartId}`);
        lines.push("\n*Call doordash_place_order with this cart ID to place the order.*");
        return ok(lines.join("\n"));
      }),
  );

  server.registerTool(
    "doordash_place_order",
    {
      description: "Place a DoorDash order. THIS WILL CHARGE YOUR CARD.",
      inputSchema: {
        cart_id: z.string().describe("Cart ID from doordash_checkout"),
        tip_cents: z.number().optional().default(0).describe("Tip in cents (default 0)"),
        payment_card_id: z.string().optional().describe("Payment card ID"),
        store_id: z.string().optional().describe("Store ID (auto-detected)"),
      },
    },
    ({ cart_id, tip_cents, payment_card_id, store_id }) =>
      wrap(async () => {
        // Get fee tally for total
        const summary = await api.checkout.getFeeTally(cart_id);
        if (summary.totalCents === 0) return err("Could not determine order total.");

        // Resolve store ID
        let sid = store_id ?? "";
        if (!sid) {
          const carts = await api.cart.listCarts();
          sid = carts.find((c) => c.id === cart_id)?.storeId ?? "";
        }

        const result = await api.checkout.createOrder({
          cartId: cart_id,
          storeId: sid,
          totalCents: summary.totalCents,
          tipCents: tip_cents,
          paymentCardId: payment_card_id,
        });

        if (result.paymentStatus === "paid") {
          return ok(
            `Order placed and payment confirmed! Order ID: ${result.orderUuid}\nTotal: $${(result.totalCents / 100).toFixed(2)} (includes $${(result.tipCents / 100).toFixed(2)} tip)\n\nUse doordash_order_status to track.`,
          );
        }
        if (result.paymentStatus === "failed") {
          return err(`Order submitted but payment failed: ${result.errorMessage}`);
        }
        return ok(
          `Order submitted. Order ID: ${result.orderUuid}\nPayment processing. Use doordash_order_status to check.`,
        );
      }),
  );

  server.registerTool(
    "doordash_order_status",
    {
      description: "Check the status of a DoorDash order",
      inputSchema: {
        order_id: z.string().describe("Order UUID from doordash_place_order"),
      },
    },
    ({ order_id }) =>
      wrap(async () => {
        const status = await api.checkout.getOrderStatus(order_id);
        const lines = ["# Order Status\n", `Order ID: ${order_id}`];
        for (const [key, val] of Object.entries(status)) {
          if (key !== "__typename" && val != null) lines.push(`${key}: ${val}`);
        }
        return ok(lines.join("\n"));
      }),
  );

  server.registerTool(
    "doordash_orders",
    {
      description: "Get recent DoorDash order history",
      inputSchema: {
        limit: z.number().optional().default(5).describe("Number of orders (default 5)"),
      },
    },
    ({ limit }) =>
      wrap(async () => {
        const orders = await api.orders.getRecentOrders(limit);
        if (orders.length === 0) return ok("No recent orders found.");

        const lines = ["# Recent Orders\n"];
        for (const order of orders) {
          lines.push(`**${order.storeName}** — ${order.total}`);
          if (order.date) lines.push(`  Date: ${order.date}`);
          if (order.status) lines.push(`  Status: ${order.status}`);
          if (order.items) lines.push(`  Items: ${order.items}`);
          lines.push("");
        }
        return ok(lines.join("\n"));
      }),
  );

  // ── Payment ────────────────────────────────────────────

  server.registerTool(
    "doordash_payment_methods",
    { description: "List saved payment methods" },
    () =>
      wrap(async () => {
        const methods = await api.account.getPaymentMethods();
        if (methods.length === 0) return err("No payment methods found.");

        const lines = ["# Payment Methods\n"];
        for (const m of methods) {
          const def = m.isDefault ? " **(default)**" : "";
          lines.push(
            `- ${m.brand} ****${m.last4} exp ${m.expMonth}/${m.expYear}${def} (ID: ${m.id})`,
          );
        }
        return ok(lines.join("\n"));
      }),
  );

  server.registerTool(
    "doordash_add_card",
    {
      description: "Add a payment card to DoorDash.",
      inputSchema: {
        card_number: z.string().describe("Full card number"),
        exp_month: z.string().describe("Expiration month (e.g. '01')"),
        exp_year: z.string().describe("Expiration year (e.g. '2029')"),
        cvc: z.string().describe("CVC/CVV code"),
      },
    },
    ({ card_number, exp_month, exp_year, cvc }) =>
      wrap(async () => {
        const result = await api.account.addCard({
          cardNumber: card_number,
          expMonth: exp_month,
          expYear: exp_year,
          cvc,
        });
        return ok(
          `Added ${result.brand} ****${result.last4} (${exp_month}/${exp_year}).`,
        );
      }),
  );

  // ── Addresses ──────────────────────────────────────────

  server.registerTool(
    "doordash_addresses",
    { description: "List saved delivery addresses" },
    () =>
      wrap(async () => {
        const addrs = await api.account.getAddresses();
        if (addrs.length === 0) return err("No saved addresses.");

        const lines = ["# Delivery Addresses\n"];
        for (const a of addrs) {
          lines.push(`- ${a.street}, ${a.city}, ${a.state} ${a.zipCode} (ID: ${a.id})`);
        }
        return ok(lines.join("\n"));
      }),
  );

  server.registerTool(
    "doordash_add_address",
    {
      description: "Add a delivery address.",
      inputSchema: {
        street: z.string().describe("Street address"),
        city: z.string().describe("City"),
        state: z.string().describe("State abbreviation"),
        zip_code: z.string().describe("ZIP code"),
        lat: z.number().describe("Latitude"),
        lng: z.number().describe("Longitude"),
        google_place_id: z.string().optional().describe("Google Place ID"),
      },
    },
    ({ street, city, state, zip_code, lat, lng, google_place_id }) =>
      wrap(async () => {
        // Check for duplicate
        const existing = await api.account.getAddresses();
        const dupe = existing.find(
          (a) => a.street === street && a.city === city && a.state === state,
        );
        if (dupe) return ok(`Address "${street}, ${city}" already exists (ID: ${dupe.id}).`);

        await api.account.addAddress({
          street, city, state, zipCode: zip_code, lat, lng, googlePlaceId: google_place_id,
        });
        return ok(`Added address: ${street}, ${city}, ${state} ${zip_code}`);
      }),
  );

  server.registerTool(
    "doordash_set_address",
    {
      description: "Set the active delivery address.",
      inputSchema: {
        address_id: z.string().describe("Address ID from doordash_addresses"),
      },
    },
    ({ address_id }) =>
      wrap(async () => {
        await api.account.setDefaultAddress(address_id);
        const addrs = await api.account.getAddresses();
        const match = addrs.find((a) => String(a.id) === String(address_id));
        const name = match ? `${match.street}, ${match.city}` : address_id;
        return ok(`Delivery address set to: ${name}`);
      }),
  );

  // ── Group Orders ───────────────────────────────────────

  server.registerTool(
    "doordash_create_group_order",
    {
      description: "Create a group order at a restaurant. Returns a share link.",
      inputSchema: {
        store_id: z.string().describe("DoorDash store ID"),
      },
    },
    ({ store_id }) =>
      wrap(async () => {
        const menu = await api.menu.getStoreMenu(store_id);
        const result = await api.group.createGroupCart(store_id, menu.menuId);

        const lines = [
          `# Group Order Created: ${menu.name}\n`,
          `**Share link:** ${result.shareUrl}`,
          `**Cart ID:** ${result.id}`,
          `**Type:** Creator pays for all\n`,
          "Send the share link to others.",
          "Use `doordash_group_order_status` to see everyone's items.",
          "Use `doordash_checkout` with this cart to place the order.",
        ];
        return ok(lines.join("\n"));
      }),
  );

  server.registerTool(
    "doordash_group_order_status",
    {
      description: "View a group order's items broken down by person.",
      inputSchema: {
        cart_id: z.string().describe("Group cart ID"),
      },
    },
    ({ cart_id }) =>
      wrap(async () => {
        const gc = await api.group.getGroupCart(cart_id);
        const lines = [
          "# Group Order\n",
          `Share link: ${gc.shareUrl}`,
          `Subtotal: $${(gc.subtotal / 100).toFixed(2)}\n`,
        ];

        if (gc.members.length === 0) {
          lines.push("No one has added items yet.");
        }

        for (const member of gc.members) {
          const status = member.isFinalized ? "finalized" : "still adding";
          lines.push(`## ${member.name} (${status})`);
          for (const item of member.items) {
            const price = item.price ? `$${(item.price / 100).toFixed(2)}` : "";
            lines.push(`- ${item.quantity}x ${item.name} ${price} (item ID: ${item.id})`);
          }
          lines.push("");
        }

        return ok(lines.join("\n"));
      }),
  );
}
