import { WalletQueries } from "../port/WalletQueries";
import { GetTransactionInput } from "./GetTransactionInput";
import { GetTransactionOutput } from "./GetTransactionOutput";
export class GetTransaction {
  constructor(private readonly queries: WalletQueries) {}
  async execute(input: GetTransactionInput): Promise<GetTransactionOutput> {
    return this.queries.transaction(input.transactionId);
  }
}
