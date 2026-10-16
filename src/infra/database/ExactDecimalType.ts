import { FailureCode } from "../../domain/entity/DomainError";
import { Type } from "@mikro-orm/core";
export class ExactDecimalType extends Type<string, string> {
  override convertToDatabaseValue(value: string): string {
    if (typeof value !== "string")
      throw new TypeError(FailureCode.MoneyMustBeString);
    return value;
  }
  override convertToJSValue(value: string): string {
    if (typeof value !== "string")
      throw new TypeError(FailureCode.MoneyMustBeString);
    return value;
  }
  override compareAsType(): string {
    return "string";
  }
  override compareValues(a: string, b: string): boolean {
    return a === b;
  }
  override getColumnType(): string {
    return "numeric";
  }
}
