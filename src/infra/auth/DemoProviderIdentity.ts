import { ProviderIdentityPort } from "../../application/port/ProviderIdentityPort";

// Demo policy. A production adapter must verify issuer, audience and JWKS.
export class DemoProviderIdentity implements ProviderIdentityPort {
  async assertProvider(
    _providerId: string,
    _authorization?: string,
  ): Promise<void> {}
}
