import { randomUUID } from "node:crypto";
import { UnitOfWork } from "../port/UnitOfWork";
import { OpenWalletInput } from "./OpenWalletInput";
import { OpenWalletOutput } from "./OpenWalletOutput";
import { Money } from "../../domain/entity/Money";
import { Wallet } from "../../domain/entity/Wallet";
import { WagerTransaction } from "../../domain/entity/WagerTransaction";
import { WalletLedgerEntry } from "../../domain/entity/WalletLedgerEntry";
import { OutboxMessage } from "../../domain/entity/OutboxMessage";
import { WalletBalanceChanged } from "../../domain/event/WalletBalanceChanged";
import { WagerTransactionProcessed } from "../../domain/event/WagerTransactionProcessed";
export class OpenWallet {
  constructor(private readonly uow: UnitOfWork) {}
  async execute(input: OpenWalletInput): Promise<OpenWalletOutput> {
    return this.uow.run(async (db) => {
      const wallet = Wallet.open({
        id: randomUUID(),
        playerId: input.playerId,
        initialBalance: Money.from(input.initialBalance),
      });
      await db.wallets.insert(wallet);
      if (wallet.balance.isPositive()) {
        const tx = WagerTransaction.create({
          id: randomUUID(),
          providerId: "__internal__",
          externalTransactionId: wallet.id,
          idempotencyKey: `opening:${wallet.id}`,
          payloadHash: wallet.id,
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: "opening",
          gameId: "opening",
          kind: "OPENING",
          money: wallet.balance,
        });
        tx.markProcessed(undefined, new Date(), wallet.balance);
        await db.transactions.save(tx);
        const entry = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: tx.id,
          direction: "CREDIT",
          money: wallet.balance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: wallet.balance,
          createdAt: new Date(),
        });
        await db.ledger.append(entry);
        const props = {
          eventId: randomUUID(),
          aggregateId: wallet.id,
          correlationId: wallet.id,
          occurredAt: new Date(),
          data: {
            transactionId: tx.id,
            walletId: wallet.id,
            status: "PROCESSED",
            money: wallet.balance.toJSON(),
            balance: wallet.balance.toJSON(),
            walletVersion: 1,
          },
        };
        await db.outbox.enqueue(
          OutboxMessage.enqueue(WagerTransactionProcessed.create(props)),
        );
        await db.outbox.enqueue(
          OutboxMessage.enqueue(
            WalletBalanceChanged.create({
              ...props,
              eventId: randomUUID(),
              data: {
                ...props.data,
                direction: "CREDIT",
                balanceBefore: Money.zero(wallet.currency).toJSON(),
                balanceAfter: wallet.balance.toJSON(),
              },
            }),
          ),
        );
      }
      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
}
