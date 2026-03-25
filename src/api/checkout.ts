import type { GraphQLClient } from "./graphql.js";
import type { DoorDashSession } from "../client/session.js";

export interface FeeLineItem {
  label: string;
  amount: string;
}

export interface CheckoutSummary {
  lineItems: FeeLineItem[];
  total: string;
  totalCents: number;
  cartId: string;
}

export interface OrderResult {
  orderUuid: string;
  totalCents: number;
  tipCents: number;
  paymentStatus: "pending" | "paid" | "failed";
  errorMessage?: string;
}

export class CheckoutAPI {
  constructor(
    private gql: GraphQLClient,
    private session: DoorDashSession,
  ) {}

  async getFeeTally(cartId: string): Promise<CheckoutSummary> {
    const q = this.gql.loadQuery("totalFeeTally.graphql");
    const consumerId = this.session.getConsumerId();

    const data = await this.gql.query<any>(
      "totalFeeTally",
      { cartId, consumerId },
      q,
    );

    const tally = data?.totalFeeTally;
    const lineItems: FeeLineItem[] = [];

    for (const group of tally?.lineItemGroups ?? []) {
      for (const item of group.lineItems ?? []) {
        lineItems.push({
          label: item.label ?? "Fee",
          amount: item.finalMoney?.displayString ?? "",
        });
      }
    }

    const total =
      tally?.totalBeforeTaxes?.displayString ??
      tally?.styledSummary?.displayString ??
      "";
    const totalCents = tally?.totalBeforeTaxes?.unitAmount ?? 0;

    return { lineItems, total, totalCents, cartId };
  }

  async createOrder(params: {
    cartId: string;
    storeId: string;
    totalCents: number;
    tipCents?: number;
    paymentCardId?: string;
  }): Promise<OrderResult> {
    const q = this.gql.loadQuery("createOrderFromCart.graphql");
    const tipCents = params.tipCents ?? 0;
    const isCardPayment = !!params.paymentCardId;

    const data = await this.gql.query<any>("createOrderFromCart", {
      cartId: params.cartId,
      total: params.totalCents + tipCents,
      sosDeliveryFee: 0,
      storeId: params.storeId,
      isPickupOrder: false,
      verifiedAgeRequirement: false,
      deliveryTime: "ASAP",
      deliveryOptionType: "NOT_SET",
      tipAmounts: [{ tipRecipient: "DASHER", amount: tipCents }],
      paymentMethod: params.paymentCardId
        ? parseInt(params.paymentCardId)
        : null,
      isCardPayment,
      membershipId: "",
      programId: "",
      attributionData: "{}",
      fulfillsOwnDeliveries: false,
      menuOptions: null,
      teamId: null,
      budgetId: null,
      giftOptions: null,
      recipientShippingDetails: null,
      workOrderOptions: null,
    }, q);

    const order = data?.createOrderFromCart;
    if (!order?.orderUuid) {
      throw new Error("Order could not be placed.");
    }

    // Poll payment status
    const paymentResult = await this.pollPayment(order.orderUuid);

    return {
      orderUuid: order.orderUuid,
      totalCents: params.totalCents + tipCents,
      tipCents,
      ...paymentResult,
    };
  }

  async pollPayment(orderId: string): Promise<{
    paymentStatus: "pending" | "paid" | "failed";
    errorMessage?: string;
  }> {
    const q = this.gql.loadQuery("pollOrderPaymentStatus.graphql");

    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const data = await this.gql.query<any>(
        "pollOrderPaymentStatus",
        { orderId },
        q,
      );

      const ps = data?.pollOrderPaymentStatus;
      if (ps?.paymentStatus === 1) {
        return { paymentStatus: "paid" };
      }
      if (ps?.paymentStatus === 2) {
        return {
          paymentStatus: "failed",
          errorMessage: ps.errorMessage ?? ps.errorType ?? "Payment failed",
        };
      }
    }

    return { paymentStatus: "pending" };
  }

  async getOrderStatus(orderId: string): Promise<Record<string, unknown>> {
    const q = this.gql.loadQuery("pollOrderPaymentStatus.graphql");
    const data = await this.gql.query<any>(
      "pollOrderPaymentStatus",
      { orderId },
      q,
    );
    return data?.pollOrderPaymentStatus ?? {};
  }
}
