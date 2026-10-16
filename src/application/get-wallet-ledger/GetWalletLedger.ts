import { WalletQueries } from "../port/WalletQueries";
import { GetWalletLedgerInput } from "./GetWalletLedgerInput";
import { GetWalletLedgerOutput } from "./GetWalletLedgerOutput";
export class GetWalletLedger {
  constructor(private readonly queries: WalletQueries) {}
  async execute(input: GetWalletLedgerInput): Promise<GetWalletLedgerOutput> {
    return this.queries.ledger(input.walletId, input.cursor, input.limit);
  }
}
