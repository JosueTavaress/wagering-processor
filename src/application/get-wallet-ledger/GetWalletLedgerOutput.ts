import { LedgerView } from "../port/WalletQueries";
export type GetWalletLedgerOutput = {
  entries: LedgerView[];
  nextCursor: string | null;
};
