import type { GraphQLClient } from "./graphql.js";

export interface Order {
  storeName: string;
  total: string;
  date: string;
  status: string;
  items: string;
}

// This query needs to be captured from a real session.
// Using a minimal version with the fields the tools need.
const GET_ORDERS_QUERY = `
query getConsumerOrdersWithDetails {
  getConsumerOrdersWithDetails {
    orderDetails {
      storeName
      grandTotal { displayString }
      totalCharged { displayString }
      createdAt
      submittedAt
      deliveryStatus
      orderStatus
      orderItems { name quantity }
    }
  }
}`;

export class OrdersAPI {
  constructor(private gql: GraphQLClient) {}

  async getRecentOrders(limit = 5): Promise<Order[]> {
    const data = await this.gql.query<any>(
      "getConsumerOrdersWithDetails",
      {},
      GET_ORDERS_QUERY,
    );

    const orders = data?.getConsumerOrdersWithDetails?.orderDetails ?? [];
    return orders.slice(0, limit).map((order: any) => ({
      storeName: order.storeName ?? "Unknown Store",
      total:
        order.grandTotal?.displayString ??
        order.totalCharged?.displayString ??
        "",
      date: order.createdAt ?? order.submittedAt ?? "",
      status: order.deliveryStatus ?? order.orderStatus ?? "",
      items: (order.orderItems ?? [])
        .map((i: any) => `${i.name} ×${i.quantity}`)
        .join(", "),
    })) as Order[];
  }
}
