import type { GraphQLClient } from "./graphql.js";

export interface GroupOrder {
  id: string;
  shareUrl: string;
  subtotal: number;
  members: {
    name: string;
    isFinalized: boolean;
    items: { id: string; name: string; quantity: number; price: number }[];
  }[];
}

export class GroupAPI {
  constructor(private gql: GraphQLClient) {}

  async createGroupCart(
    storeId: string,
    menuId: string,
  ): Promise<{ id: string; shareUrl: string }> {
    const data = await this.gql.query<any>(
      "createGroupCart",
      { restaurant: storeId, menu: String(menuId) },
      `mutation createGroupCart($restaurant: String!, $menu: String!) {
        createGroupCart(restaurant: $restaurant, menu: $menu) {
          id groupCart groupCartType shortenedUrl urlCode __typename
        }
      }`,
    );

    const cart = data?.createGroupCart;
    if (!cart?.id) throw new Error("Could not create group order.");

    return { id: cart.id, shareUrl: cart.shortenedUrl ?? "" };
  }

  async getGroupCart(cartId: string): Promise<GroupOrder> {
    const data = await this.gql.query<any>(
      "getGroupCart",
      { cartId },
      `query getGroupCart($cartId: ID!) {
        getGroupCart(cartId: $cartId) {
          id groupCart groupCartType shortenedUrl subtotal
          orders {
            id
            consumer { firstName lastName __typename }
            orderItems {
              id quantity
              item { name __typename }
              singlePrice priceOfTotalQuantity
              __typename
            }
            isSubCartFinalized
            __typename
          }
          __typename
        }
      }`,
    );

    const gc = data?.getGroupCart;
    if (!gc) throw new Error("Could not load group order.");

    return {
      id: gc.id,
      shareUrl: gc.shortenedUrl ?? "",
      subtotal: gc.subtotal ?? 0,
      members: (gc.orders ?? []).map((order: any) => ({
        name: `${order.consumer?.firstName ?? "?"} ${order.consumer?.lastName ?? ""}`.trim(),
        isFinalized: !!order.isSubCartFinalized,
        items: (order.orderItems ?? []).map((item: any) => ({
          id: item.id ?? "",
          name: item.item?.name ?? "?",
          quantity: item.quantity ?? 1,
          price: item.singlePrice ?? 0,
        })),
      })),
    };
  }
}
