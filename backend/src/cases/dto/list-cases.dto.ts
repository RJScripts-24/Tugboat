import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

const STAGES = [
  "detected",
  "diagnosed",
  "intervening",
  "waiting",
  "escalated",
  "promised",
  "recovered",
  "halted",
  "exhausted",
] as const;

const TYPES = [
  "PAYMENT_FAILED",
  "CHECKOUT_ABANDONED",
  "MANDATE_FAILED",
  "INVOICE_OVERDUE",
] as const;

const CAUSES = [
  "BANK_GATEWAY_DEGRADED",
  "INSUFFICIENT_FUNDS",
  "CUSTOMER_DISTRACTED",
  "CARD_EXPIRED",
  "MANDATE_REVOKED",
  "UNKNOWN",
] as const;

/** `?stage=a&stage=b` and `?stage=a,b` both arrive as a list. */
const toArray = ({ value }: { value: unknown }): string[] | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(",");
  return raw.map((entry) => String(entry).trim()).filter(Boolean);
};

export class ListCasesDto {
  @IsOptional() @Transform(toArray) @IsIn(STAGES, { each: true })
  stage?: (typeof STAGES)[number][];

  @IsOptional() @Transform(toArray) @IsIn(TYPES, { each: true })
  type?: (typeof TYPES)[number][];

  @IsOptional() @Transform(toArray) @IsIn(CAUSES, { each: true })
  cause?: (typeof CAUSES)[number][];

  @IsOptional() @IsString() search?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) minPaise?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) maxPaise?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) skip?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) take?: number;
}
