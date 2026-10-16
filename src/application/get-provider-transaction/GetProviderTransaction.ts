import { WalletQueries } from "../port/WalletQueries";
import { GetProviderTransactionInput } from "./GetProviderTransactionInput";
import { GetProviderTransactionOutput } from "./GetProviderTransactionOutput";
export class GetProviderTransaction {
  constructor(private readonly queries: WalletQueries) {}
  async execute(
    input: GetProviderTransactionInput,
  ): Promise<GetProviderTransactionOutput> {
    return this.queries.providerTransaction(
      input.providerId,
      input.externalTransactionId,
    );
  }
}
