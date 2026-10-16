import { WalletQueries } from "../port/WalletQueries";
import { GetWalletInput } from "./GetWalletInput";
import { GetWalletOutput } from "./GetWalletOutput";
export class GetWallet {
  constructor(private readonly queries: WalletQueries) {}
  async execute(input: GetWalletInput): Promise<GetWalletOutput> {
    return this.queries.wallet(input.walletId);
  }
}
