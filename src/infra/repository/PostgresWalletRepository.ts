import { EntityManager } from "@mikro-orm/postgresql";
import { WalletRepository } from "../../domain/repository/WalletRepository";
import { Wallet } from "../../domain/entity/Wallet";
import { Money } from "../../domain/entity/Money";
import { WalletRecord } from "../database/Database";
import { LockMode } from "@mikro-orm/core";
export class PostgresWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}
  async lock(id: string) {
    const r = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return r
      ? Wallet.rehydrate({
          id: r.id,
          playerId: r.playerId,
          balance: Money.from({ amount: r.balance, currency: r.currency }),
          version: r.version,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })
      : undefined;
  }
  async insert(w: Wallet) {
    await this.em.execute(
      "insert into wallets(id,player_id,currency,balance,version,created_at,updated_at) values (?,?,?,?,?,?,?)",
      [
        w.id,
        w.playerId,
        w.currency,
        w.balance.toString(),
        w.version,
        w.createdAt,
        w.updatedAt,
      ],
    );
  }
  async save(w: Wallet) {
    await this.em.execute(
      "update wallets set balance=?,version=?,updated_at=? where id=?",
      [w.balance.toString(), w.version, w.updatedAt, w.id],
    );
  }
}
