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
  private sessions = new Map<string, GuestSession>();

  constructor(private http: HttpClient) {}

  getSession(externalUserId: string): GuestSession | undefined {
    return this.sessions.get(externalUserId);
  }

  /**
   * Ensure a guest session exists for this user. If one already exists,
   * just register them on the new cart. If not, create a fresh guest identity.
   */
  async joinGroupOrder(params: {
    cartId: string;
    storeId: string;
    externalUserId: string;
    firstName: string;
    lastName: string;
  }): Promise<GuestSession> {
    const existing = this.sessions.get(params.externalUserId);

    if (existing) {
      const nameChanged =
        existing.firstName !== params.firstName ||
        existing.lastName !== params.lastName;
      if (nameChanged) {
        await existing.gql.query<any>(
          "editConsumerProfileInformation",
          { firstName: params.firstName, lastName: params.lastName },
          EDIT_PROFILE_MUTATION,
        );
        existing.firstName = params.firstName;
        existing.lastName = params.lastName;
        log(`updated guest name to ${params.firstName} ${params.lastName}`);
      }

      await existing.gql.query(
        "groupCart",
        { id: params.cartId, shouldApplyAutocheckoutConfig: true },
        GROUP_CART_QUERY,
      );
      log(
        `registered ${params.firstName} ${params.lastName} on cart ${params.cartId}`,
      );
      return existing;
    }

    const jar = new CookieJar();
    const ctx = new GuestSessionContext(jar);

    log(`creating guest session for ${params.firstName} ${params.lastName}...`);

    const guestUrl =
      `https://www.doordash.com/consumer/guest/` +
      `?next=/cart/${params.cartId}` +
      `&storeId=${params.storeId}` +
      `&orderCartId=${params.cartId}`;

    await this.http.get(guestUrl, {
      headers: { Accept: "text/html" },
      cookieJar: jar,
    });

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
    log(`guest registered on cart ${params.cartId}`);

    const guest: GuestSession = {
      session: ctx,
      gql,
      cart,
      consumerId,
      firstName: params.firstName,
      lastName: params.lastName,
    };

    this.sessions.set(params.externalUserId, guest);
    return guest;
  }

  async finalizeGuestOrder(
    cartId: string,
    externalUserId: string,
  ): Promise<void> {
    const guest = this.sessions.get(externalUserId);
    if (!guest) throw new Error(`No guest session for user ${externalUserId}.`);

    await guest.gql.query(
      "setIsSubCartFinalized",
      { cartId, isSubCartFinalized: true },
      FINALIZE_SUB_CART_MUTATION,
    );

    log(`finalized sub-cart for ${guest.firstName} ${guest.lastName}`);
  }
}
