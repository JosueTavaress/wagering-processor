export interface ProviderIdentityPort {
  assertProvider(providerId: string, authorization?: string): Promise<void>;
}
