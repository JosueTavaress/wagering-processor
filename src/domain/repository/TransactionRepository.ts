import { WagerTransaction, Kind } from "../entity/WagerTransaction";
export interface TransactionRepository {
  findIdentity(
    key: string,
    provider: string,
    external: string,
  ): Promise<WagerTransaction[]>;
  findReference(
    provider: string,
    external: string,
  ): Promise<WagerTransaction | undefined>;
  hasReversal(referenceId: string, kind: Kind): Promise<boolean>;
  save(tx: WagerTransaction): Promise<void>;
}
