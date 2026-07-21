import { randomUUID } from "crypto";
import type { TokenProvider } from "./armHostPoolClient";

/**
 * Placeholder TokenProvider implementation. Acquires an app-only ARM token
 * for a given customer tenant via OAuth client-credentials flow against our
 * multi-tenant Entra app registration, scoped to https://management.azure.com/.default.
 * In production this uses @azure/identity's ClientSecretCredential/
 * ClientCertificateCredential with the app's client id + secret (from Key
 * Vault) and the target tenant id.
 *
 * NOT validated end-to-end in this sandbox (needs a real multi-tenant app
 * registration + a customer tenant that granted RBAC). Structured so a real
 * implementation can be dropped in without touching any calling code.
 */
export class ClientCredentialsArmTokenProvider implements TokenProvider {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string
  ) {}

  async getArmToken(entraTenantId: string): Promise<string> {
    const tokenUrl = `https://login.microsoftonline.com/${entraTenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: "https://management.azure.com/.default",
      grant_type: "client_credentials",
    });
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`Failed to acquire ARM token for tenant ${entraTenantId}: ${res.status}`);
    }
    const data: any = await res.json();
    return data.access_token;
  }
}

/** Test/dev double — never used against real Azure. */
export class FakeTokenProvider implements TokenProvider {
  async getArmToken(_entraTenantId: string): Promise<string> {
    return `fake-token-${randomUUID()}`;
  }
}
