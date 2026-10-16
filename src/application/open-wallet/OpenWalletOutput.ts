import { MoneyProps } from "../../domain/entity/Money";
export type OpenWalletOutput = {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
};
