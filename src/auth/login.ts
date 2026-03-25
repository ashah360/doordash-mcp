import type { HttpClient } from "../client/http.js";
import type { DoorDashSession } from "../client/session.js";

const log = (msg: string) => process.stderr.write(`[dd-auth] ${msg}\n`);

export interface LoginResult {
  status: "success" | "mfa_required" | "error";
  message: string;
}

// Inline GraphQL — these are tiny auth-specific mutations, no .graphql files needed
const GENERATE_PASSCODE_MUTATION = `
mutation generatePasscodeBFFRisk(
  $action: String!, $channel: String!, $experience: String!,
  $language: String!, $mfaDetail: MfaDetailInput!, $shouldForceNewCode: Boolean!
) {
  generatePasscodeBFF(
    action: $action, channel: $channel, experience: $experience,
    language: $language, mfaDetail: $mfaDetail, shouldForceNewCode: $shouldForceNewCode
  ) {
    ... on GeneratePasscodeSuccess { message }
    ... on GeneratePasscodeError { message }
  }
}`;

const VERIFY_PASSCODE_MUTATION = `
mutation verifyPasscodeBFFRisk(
  $action: String!, $code: String!, $mfaDetail: MfaDetailInput!
) {
  verifyPasscodeBFF(action: $action, code: $code, mfaDetail: $mfaDetail) {
    ... on VerifyPasscodeSuccess { redirectUri }
    ... on VerifyPasscodeError { message }
  }
}`;

const POST_LOGIN_QUERY = `
query postLoginQuery($action: String!, $code: String!) {
  postLogin(action: $action, code: $code) {
    status isLoggedInPriorToTokenExchange nextUrl __typename
  }
}`;

export class LoginFlow {
  constructor(
    private http: HttpClient,
    private session: DoorDashSession,
  ) {}

  /** Run the full login flow. Returns immediately if already authenticated. */
  async login(email?: string, password?: string): Promise<LoginResult> {
    if (this.session.isAuthenticated()) {
      return { status: "success", message: "Already logged in." };
    }

    const user = email ?? process.env.DOORDASH_EMAIL;
    const pass = password ?? process.env.DOORDASH_PASSWORD;

    if (!user) {
      return {
        status: "error",
        message:
          "No email configured. Set the DOORDASH_EMAIL environment variable.",
      };
    }
    if (!pass) {
      return {
        status: "error",
        message:
          "No password configured. Set the DOORDASH_PASSWORD environment variable.",
      };
    }

    // Step 1: Establish identity session
    log("establishing identity session...");
    const r1 = await this.http.get(
      "https://identity.doordash.com/auth?" +
        new URLSearchParams({
          client_id: "1666519390426295040",
          layout: "consumer_web",
          prompt: "none",
          redirect_uri: "https://www.doordash.com/",
          response_type: "code",
          scope: "*",
          state: "none",
        }).toString(),
      { headers: { Accept: "text/html" } },
    );

    const xsrf = this.session.cookieJar.get("XSRF-TOKEN");
    if (!xsrf) {
      return {
        status: "error",
        message: `Identity page returned ${r1.status} but no XSRF token.`,
      };
    }
    log("got XSRF token");

    // Step 2: Password authentication
    log("authenticating with password...");
    const r2 = await this.http.post(
      "https://identity.doordash.com/auth",
      {
        clientId: "1666519390426295040",
        deviceId: null,
        layout: "consumer_web",
        password: pass,
        redirectUri: "https://www.doordash.com/",
        responseType: "code",
        scope: "*",
        state: "none",
        username: user,
      },
      {
        headers: {
          Origin: "https://identity.doordash.com",
          "X-XSRF-TOKEN": xsrf,
        },
      },
    );

    const authData = r2.json() as Record<string, unknown>;

    // Check for risk block
    if (
      typeof authData?.message === "string" &&
      authData.message.includes("RISK-403")
    ) {
      return {
        status: "error",
        message: "Account blocked by DoorDash risk detection.",
      };
    }

    // Direct success — no MFA needed
    if (authData?.redirectUri) {
      log("password login success, exchanging auth code...");
      const result = await this.exchangeAuthCode(
        authData.redirectUri as string,
      );
      return result;
    }

    // MFA required
    if (authData?.statusCode === "verification_required") {
      const mfa = authData.mfaDetail as Record<string, string>;
      log(`MFA required. userId=${mfa?.userId}`);
      this.session.setState("mfaDetail", mfa);
      this.session.setState("email", user);
      this.session.save();

      return {
        status: "mfa_required",
        message: `Verification required. Call doordash_verify with the code sent to your email/phone.`,
      };
    }

    return {
      status: "error",
      message: `Unexpected auth response: ${JSON.stringify(authData).slice(0, 200)}`,
    };
  }

  /** Request an MFA verification code via email or SMS. */
  async requestMfaCode(channel: "email" | "sms" = "email"): Promise<void> {
    const mfa = this.session.getState<Record<string, string>>("mfaDetail");
    if (!mfa) throw new Error("No MFA session. Call login() first.");

    // Need doordash.com cookies for graphql
    await this.ensureDoordashCookies();

    log(`requesting ${channel} verification code...`);
    const resp = await this.ddGraphql(
      "generatePasscodeBFFRisk",
      {
        action: "login",
        channel,
        experience: "doordash",
        language: "en-us",
        mfaDetail: {
          deviceId: mfa.deviceId,
          sessionId: mfa.sessionId,
          userId: mfa.userId,
        },
        shouldForceNewCode: true,
      },
      GENERATE_PASSCODE_MUTATION,
    );

    const data = resp as Record<string, unknown>;
    if (data?.errors) {
      const msg = (data.errors as any[])[0]?.message ?? "Unknown error";
      throw new Error(`Failed to send code: ${msg}`);
    }
    log("verification code sent");
  }

  /** Verify an MFA code and complete login. */
  async verifyMfa(code: string): Promise<LoginResult> {
    const mfa = this.session.getState<Record<string, string>>("mfaDetail");
    if (!mfa) {
      return {
        status: "error",
        message: "No MFA session. Call doordash_login first.",
      };
    }

    await this.ensureDoordashCookies();

    log(`verifying code: ${code}...`);
    const resp = await this.ddGraphql(
      "verifyPasscodeBFFRisk",
      {
        action: "login",
        code,
        mfaDetail: {
          deviceId: mfa.deviceId,
          sessionId: mfa.sessionId,
          userId: mfa.userId,
        },
      },
      VERIFY_PASSCODE_MUTATION,
    );

    const data = resp as Record<string, unknown>;

    if (data?.errors) {
      const msg = (data.errors as any[])[0]?.message ?? "Unknown error";
      return { status: "error", message: `Verification failed: ${msg}` };
    }

    const redirectUri = (data?.data as any)?.verifyPasscodeBFF?.redirectUri;
    if (!redirectUri) {
      const errorMsg = (data?.data as any)?.verifyPasscodeBFF?.message;
      return {
        status: "error",
        message: errorMsg ?? "Verification failed — no redirect URI returned.",
      };
    }

    log("MFA verified, exchanging auth code...");
    return this.exchangeAuthCode(redirectUri);
  }

  /** Exchange an auth code (from redirect URI) for session cookies. */
  private async exchangeAuthCode(redirectUri: string): Promise<LoginResult> {
    // Extract the UUID auth code
    const codeMatch = redirectUri.match(
      /code=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
    );
    const authCode = codeMatch?.[1];
    if (!authCode) {
      return {
        status: "error",
        message: "Could not extract auth code from redirect URI.",
      };
    }

    log(`auth code: ${authCode.slice(0, 8)}...`);

    // Hit the redirect URL to pick up device cookies
    await this.http.get(redirectUri, {
      headers: { Accept: "text/html" },
    });

    // Exchange the code via postLoginQuery
    log("calling postLoginQuery...");
    const resp = await this.ddGraphql(
      "postLoginQuery",
      {
        action: "Login",
        code: authCode,
      },
      POST_LOGIN_QUERY,
    );

    const data = resp as Record<string, unknown>;
    const status = (data?.data as any)?.postLogin?.status;

    // Check if auth cookies were set (postLoginQuery or the redirect may have set them)
    if (this.session.isAuthenticated()) {
      this.session.setState("mfaDetail", null);
      this.session.save();
      log("login successful!");
      return {
        status: "success",
        message: "Successfully logged into DoorDash.",
      };
    }

    if (status === "success") {
      // postLoginQuery succeeded but cookies weren't captured properly
      this.session.save();
      return {
        status: "success",
        message: "Login succeeded (postLoginQuery returned success).",
      };
    }

    return {
      status: "error",
      message: `Code exchange failed: ${JSON.stringify(data).slice(0, 200)}`,
    };
  }

  /** Ensure we have doordash.com cookies by hitting the homepage if needed. */
  private async ensureDoordashCookies(): Promise<void> {
    if (!this.session.cookieJar.get("ddweb_session_id")) {
      log("fetching doordash.com for cookies...");
      await this.http.get("https://www.doordash.com/", {
        headers: { Accept: "text/html" },
      });
    }
  }

  /** Make a GraphQL call to doordash.com with DD-specific headers. */
  private async ddGraphql(
    operation: string,
    variables: Record<string, unknown>,
    query: string,
  ): Promise<unknown> {
    const csrf = this.session.getCsrfToken();
    const resp = await this.http.post(
      `https://www.doordash.com/graphql/${operation}?operation=${operation}`,
      { operationName: operation, variables, query },
      {
        headers: {
          Origin: "https://www.doordash.com",
          Referer: "https://www.doordash.com/",
          "x-channel-id": "marketplace",
          "x-experience-id": "doordash",
          "x-csrftoken": csrf,
        },
      },
    );
    return resp.json();
  }
}
