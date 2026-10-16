import { DomainError, FailureCode } from "./DomainError";
export const Currency = {
  BRL: "BRL",
  USD: "USD",
  EUR: "EUR",
} as const;

const DecimalPlaces = 2;
const CentsPerUnit = 100n;

const supportedCurrencies: readonly string[] = Object.values(Currency);
export const ZeroAmount = "0.00";
export type MoneyProps = { amount: string; currency: string };
export class Money {
  private constructor(
    private readonly cents: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }
  static from(props: MoneyProps): Money {
    if (
      !supportedCurrencies.includes(props.currency) ||
      !/^-?(0|[1-9]\d{0,60})(\.\d{1,2})?$/.test(props.amount)
    )
      throw new DomainError(FailureCode.InvalidMoney);
    const negative = props.amount.startsWith("-");
    const [whole = "0", fraction = ""] = props.amount
      .replace("-", "")
      .split(".");
    return new Money(
      (BigInt(whole) * CentsPerUnit +
        BigInt(fraction.padEnd(DecimalPlaces, "0"))) *
        (negative ? -1n : 1n),
      props.currency,
    );
  }
  static zero(currency: string): Money {
    return Money.from({ amount: ZeroAmount, currency });
  }
  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency)
      throw new DomainError(FailureCode.CurrencyMismatch);
  }
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }
  subtract(other: Money): Money {
    return this.add(other.negate());
  }
  negate(): Money {
    return new Money(-this.cents, this.currency);
  }
  isZero(): boolean {
    return this.cents === 0n;
  }
  isPositive(): boolean {
    return this.cents > 0n;
  }
  isNegative(): boolean {
    return this.cents < 0n;
  }
  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }
  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents === other.cents;
  }
  toString(): string {
    const abs = this.cents < 0n ? -this.cents : this.cents;
    return `${this.cents < 0n ? "-" : ""}${abs / CentsPerUnit}.${(abs % CentsPerUnit).toString().padStart(DecimalPlaces, "0")}`;
  }
  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }
}
