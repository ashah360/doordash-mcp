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
      "groupCart",
      { id: cartId, shouldApplyAutocheckoutConfig: true },
      `query groupCart($id: ID!, $shouldApplyAutocheckoutConfig: Boolean) {
        orderCart(id: $id, shouldApplyAutocheckoutConfig: $shouldApplyAutocheckoutConfig) {
          id groupCart groupCartType shortenedUrl subtotal
          orders {
            id
            consumer {
              firstName lastName id
              localizedNames { informalName formalName formalNameAbbreviated __typename }
              __typename
            }
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

    const gc = data?.orderCart;
    if (!gc) throw new Error("Could not load group order.");

    return {
      id: gc.id,
      shareUrl: gc.shortenedUrl ?? "",
      subtotal: gc.subtotal ?? 0,
      members: (gc.orders ?? []).map((order: any) => {
        const c = order.consumer;
        const name =
          c?.localizedNames?.formalNameAbbreviated ||
          `${c?.firstName ?? "?"} ${c?.lastName ?? ""}`.trim();
        return {
          name,
          isFinalized: !!order.isSubCartFinalized,
          items: (order.orderItems ?? []).map((item: any) => ({
            id: item.id ?? "",
            name: item.item?.name ?? "?",
            quantity: item.quantity ?? 1,
            price: item.singlePrice ?? 0,
          })),
        };
      }),
    };
  }
}
