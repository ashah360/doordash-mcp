import type { GraphQLClient } from "./graphql.js";

export interface CartItem {
  id: string;
  name: string;
  quantity: number;
  price: number;
  nestedOptions: unknown;
  specialInstructions: string;
  menuItemId: string;
}

export interface Cart {
  id: string;
  storeName: string;
  storeId: string;
  subtotal: number;
  isGroupOrder: boolean;
  items: CartItem[];
}

export interface AddToCartResult {
  cartId: string;
  subtotal: number;
  itemName: string;
  itemQuantity: number;
}

export class CartAPI {
  constructor(private gql: GraphQLClient) {}

  async listCarts(storeId?: string): Promise<Cart[]> {
    const q = this.gql.loadQuery("listCarts.graphql");
    const context = storeId
      ? { experienceCase: "MULTI_CART_EXPERIENCE_CONTEXT", multiCartExperienceContext: { storeId } }
      : { experienceCase: "MULTI_CART_EXPERIENCE_CONTEXT", multiCartExperienceContext: {} };

    const data = await this.gql.query<any>("listCarts", {
      input: {
        cartContextFilter: context,
        cartFilter: { shouldIncludeSubmitted: true },
      },
    }, q);

    return (data?.listCarts ?? []).map((cart: any) => ({
      id: cart.id,
      storeName:
        cart.restaurant?.name ?? cart.restaurant?.business?.name ?? "Unknown",
      storeId: cart.restaurant?.id ?? "",
      subtotal: cart.subtotal ?? 0,
      isGroupOrder: !!cart.groupCart,
      items: (cart.orders?.[0]?.orderItems ?? []).map((item: any) => ({
        id: item.id,
        name: item.item?.name ?? "?",
        quantity: item.quantity ?? 1,
        price: item.singlePrice ?? 0,
        nestedOptions: item.nestedOptions,
        specialInstructions: item.specialInstructions ?? "",
        menuItemId: String(item.item?.id ?? ""),
      })),
    })) as Cart[];
  }

  async addToCart(params: {
    storeId: string;
    itemId: string;
    itemName: string;
    menuId?: string;
    quantity?: number;
    nestedOptions?: string;
    unitPrice?: number;
    cartId?: string;
    specialInstructions?: string;
  }): Promise<AddToCartResult> {
    const q = this.gql.loadQuery("addCartItem.graphql");

    // Auto-discover cart if not provided
    let cartId = params.cartId ?? "";
    if (!cartId) {
      const carts = await this.listCarts(params.storeId);
      cartId = carts[0]?.id ?? "";
    }

    const data = await this.gql.query<any>("addCartItem", {
      addCartItemInput: {
        storeId: params.storeId,
        menuId: params.menuId ?? "",
        itemId: params.itemId,
        itemName: params.itemName,
        itemDescription: "",
        currency: "USD",
        quantity: params.quantity ?? 1,
        nestedOptions: params.nestedOptions ?? "[]",
        specialInstructions: params.specialInstructions ?? "",
        substitutionPreference: "contact",
        unitPrice: params.unitPrice ?? 0,
        cartId,
        isBundle: false,
        bundleType: null,
      },
      fulfillmentContext: {
        shouldUpdateFulfillment: false,
        fulfillmentType: "Delivery",
      },
      monitoringContext: { isGroup: false },
      cartContext: { isBundle: false },
      returnCartFromOrderService: false,
      shouldKeepOnlyOneActiveCart: false,
      lowPriorityBatchAddCartItemInput: [],
    }, q);

    const cart = data?.addCartItemV2;
    if (!cart) throw new Error("Could not add item. It may require options.");

    const cartItems = cart.orders?.[0]?.orderItems ?? [];
    const matched = cartItems.find(
      (i: any) => i.item?.name === params.itemName,
    );

    return {
      cartId: cart.id,
      subtotal: cart.subtotal ?? 0,
      itemName: params.itemName,
      itemQuantity: matched?.quantity ?? params.quantity ?? 1,
    };
  }

  async removeItem(cartId: string, itemId: string): Promise<void> {
    const q = this.gql.loadQuery("removeCartItemV2.graphql");
    await this.gql.query("removeCartItemV2", { cartId, itemId }, q);
  }

  async deleteCart(cartId: string): Promise<void> {
    await this.gql.query(
      "deleteCart",
      { cartId },
      `mutation deleteCart($cartId: ID!) { deleteCart(cartId: $cartId) }`,
    );
  }
}
