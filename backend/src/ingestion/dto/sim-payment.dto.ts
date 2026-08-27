import { IsInt, IsISO8601, IsOptional, IsString, Min, ValidateIf } from "class-validator";

/**
 * A payment landing against a case that is already open.
 *
 * The same shape a Razorpay `payment.captured` webhook normalizes to in
 * Stage 10, so the path a simulated customer takes when they pay from the link
 * is the path a real one takes. Either the case or the origin object must be
 * named — a payment that cannot be attributed is not recorded, because guessing
 * which open case it belongs to would be inventing revenue.
 */
export class SimPaymentDto {
  @IsOptional() @IsString() eventId?: string;

  @ValidateIf((dto: SimPaymentDto) => dto.originId === undefined)
  @IsInt()
  @Min(1)
  caseId?: number;

  @ValidateIf((dto: SimPaymentDto) => dto.caseId === undefined)
  @IsString()
  originId?: string;

  @IsInt() @Min(1) amountPaise!: number;

  @IsString() reference!: string;

  @IsOptional() @IsString() via?: string;

  @IsOptional() @IsISO8601() occurredAt?: string;
}
