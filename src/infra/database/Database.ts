import { MikroORM } from "@mikro-orm/postgresql";
import { ExactDecimalType } from "./ExactDecimalType";
import { EntitySchema } from "@mikro-orm/core";
// Persistence metadata is kept outside the domain; numeric values always hydrate as strings.
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
const schema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "uuid", fieldName: "player_id" },
    currency: { type: "string" },
    balance: { type: ExactDecimalType, runtimeType: "string" },
    version: { type: "integer" },
    createdAt: { type: Date, fieldName: "created_at" },
    updatedAt: { type: Date, fieldName: "updated_at" },
  },
});
export async function connect() {
  return MikroORM.init({
    entities: [schema],
    clientUrl:
      process.env.DATABASE_URL ??
      "postgresql://wager:wager@localhost:5432/wager",
    pool: { min: 0, max: 10, acquireTimeoutMillis: 5000 },
    allowGlobalContext: false,
    debug: false,
  });
}
export type Database = Awaited<ReturnType<typeof connect>>;
