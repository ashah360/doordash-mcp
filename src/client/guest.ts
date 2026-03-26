import { CookieJar } from "./cookies.js";
import type { SessionContext } from "./session.js";
import type { HttpClient } from "./http.js";
import { GraphQLClient } from "../api/graphql.js";
import { CartAPI } from "../api/cart.js";

const log = (msg: string) => process.stderr.write(`[dd-guest] ${msg}\n`);

class GuestSessionContext implements SessionContext {
  readonly cookieJar: CookieJar;

  constructor(jar: CookieJar) {
    this.cookieJar = jar;
  }

  isAuthenticated(): boolean {
    return !!this.cookieJar.get("ddweb_session_id");
  }

  getCsrfToken(): string {
    return this.cookieJar.get("csrf_token") || "";
  }
}

export interface GuestSession {
  session: GuestSessionContext;
  gql: GraphQLClient;
  cart: CartAPI;
  consumerId: string;
  firstName: string;
  lastName: string;
}

const EDIT_PROFILE_MUTATION = `
mutation editConsumerProfileInformation($firstName: String, $lastName: String, $email: String, $phoneNumber: String, $defaultCountry: String) {
  updateConsumerProfileInformation(
    firstName: $firstName
    lastName: $lastName
    email: $email
    phoneNumber: $phoneNumber
    defaultCountry: $defaultCountry
  ) {
    id firstName lastName email __typename
  }
}`;

const GROUP_CART_QUERY = `
query groupCart($id: ID!, $shouldApplyAutocheckoutConfig: Boolean) {
  orderCart(id: $id, shouldApplyAutocheckoutConfig: $shouldApplyAutocheckoutConfig) {
    id subtotal groupCart groupCartType __typename
  }
}`;

const FINALIZE_SUB_CART_MUTATION = `
mutation setIsSubCartFinalized($cartId: ID!, $isSubCartFinalized: Boolean!, $cartContext: CartContextInput) {
  setIsSubCartFinalized(
    isSubCartFinalized: $isSubCartFinalized
    cartId: $cartId
    cartContext: $cartContext
  ) {
    id subtotal __typename
  }
}`;

export class GuestSessionStore {
  /** cartId -> externalUserId -> GuestSession */
  private sessions = new Map<string, Map<string, GuestSession>>();

  constructor(private http: HttpClient) {}

  getSession(cartId: string, externalUserId: string): GuestSession | undefined {
    return this.sessions.get(cartId)?.get(externalUserId);
  }

  async joinGroupOrder(params: {
    cartId: string;
    storeId: string;
    externalUserId: string;
    firstName: string;
    lastName: string;
  }): Promise<GuestSession> {
    const existing = this.getSession(params.cartId, params.externalUserId);
    if (existing) return existing;

    const jar = new CookieJar();
    const ctx = new GuestSessionContext(jar);

    log(
      `joining group order ${params.cartId} as ${params.firstName} ${params.lastName}...`,
    );

    const guestUrl =
      `https://www.doordash.com/consumer/guest/` +
      `?next=/cart/${params.cartId}` +
      `&storeId=${params.storeId}` +
      `&orderCartId=${params.cartId}`;

    await this.http.get(guestUrl, {
      headers: { Accept: "text/html" },
      cookieJar: jar,
    });

    log(`guest session established, setting profile...`);

    const gql = new GraphQLClient(this.http, ctx);
    const cart = new CartAPI(gql);

    const data = await gql.query<any>(
      "editConsumerProfileInformation",
      { firstName: params.firstName, lastName: params.lastName },
      EDIT_PROFILE_MUTATION,
    );

    const consumer = data?.updateConsumerProfileInformation;
    const consumerId = consumer?.id ?? "";
    log(`guest consumer ID: ${consumerId}`);

    await gql.query(
      "groupCart",
      { id: params.cartId, shouldApplyAutocheckoutConfig: true },
      GROUP_CART_QUERY,
    );
    log(`guest sub-cart initialized`);

    const guest: GuestSession = {
      session: ctx,
      gql,
      cart,
      consumerId,
      firstName: params.firstName,
      lastName: params.lastName,
    };

    if (!this.sessions.has(params.cartId)) {
      this.sessions.set(params.cartId, new Map());
    }
    this.sessions.get(params.cartId)!.set(params.externalUserId, guest);

    return guest;
  }

  async finalizeGuestOrder(
    cartId: string,
    externalUserId: string,
  ): Promise<void> {
    const guest = this.getSession(cartId, externalUserId);
    if (!guest)
      throw new Error(
        `No guest session for user ${externalUserId} on cart ${cartId}.`,
      );

    await guest.gql.query(
      "setIsSubCartFinalized",
      { cartId, isSubCartFinalized: true },
      FINALIZE_SUB_CART_MUTATION,
    );

    log(`finalized sub-cart for ${guest.firstName} ${guest.lastName}`);
  }

  clearCart(cartId: string): void {
    this.sessions.delete(cartId);
  }
}
