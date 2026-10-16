import { Wallet } from "../entity/Wallet";
export interface WalletRepository {
  lock(id: string): Promise<Wallet | undefined>;
  save(wallet: Wallet): Promise<void>;
  insert(wallet: Wallet): Promise<void>;
}
