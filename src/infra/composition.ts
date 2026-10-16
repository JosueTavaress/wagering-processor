import { connect } from "./database/Database";
import { PostgresUnitOfWork } from "./database/PostgresUnitOfWork";
import { SqsBroker } from "./messaging/SqsBroker";
import { PostgresWalletQueries } from "./repository/PostgresWalletQueries";
import { ProcessWagerTransaction } from "../application/process-wager-transaction/ProcessWagerTransaction";
import { OpenWallet } from "../application/open-wallet/OpenWallet";
import { GetWallet } from "../application/get-wallet/GetWallet";
import { GetWalletLedger } from "../application/get-wallet-ledger/GetWalletLedger";
import { GetTransaction } from "../application/get-transaction/GetTransaction";
import { GetProviderTransaction } from "../application/get-provider-transaction/GetProviderTransaction";
import { ReconcileWallet } from "../application/reconcile-wallet/ReconcileWallet";
import { DemoProviderIdentity } from "./auth/DemoProviderIdentity";
import { readRecoveryConfig } from "./RecoveryConfig";
export async function compose() {
  const config = readRecoveryConfig();
  const db = await connect(),
    uow = new PostgresUnitOfWork(db),
    broker = new SqsBroker(),
    queries = new PostgresWalletQueries(db);
  return {
    db,
    uow,
    broker,
    identity: new DemoProviderIdentity(),
    process: new ProcessWagerTransaction(
      uow,
      config.referenceTTL,
      config.referenceAttempts,
    ),
    open: new OpenWallet(uow),
    getWallet: new GetWallet(queries),
    getLedger: new GetWalletLedger(queries),
    getTransaction: new GetTransaction(queries),
    getProviderTransaction: new GetProviderTransaction(queries),
    reconcile: new ReconcileWallet(queries),
  };
}
export type Application = Awaited<ReturnType<typeof compose>>;
