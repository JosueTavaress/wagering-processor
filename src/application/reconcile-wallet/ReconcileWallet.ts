import { WalletQueries } from "../port/WalletQueries";
import { ReconcileWalletInput } from "./ReconcileWalletInput";
import { ReconcileWalletOutput } from "./ReconcileWalletOutput";
export class ReconcileWallet {
  constructor(private readonly queries: WalletQueries) {}
  async execute(input: ReconcileWalletInput): Promise<ReconcileWalletOutput> {
    return this.queries.reconcile(input.walletId);
  }
}
