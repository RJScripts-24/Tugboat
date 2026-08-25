import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";

const CASE_TYPES = [
  "PAYMENT_FAILED",
  "CHECKOUT_ABANDONED",
  "MANDATE_FAILED",
  "INVOICE_OVERDUE",
] as const;

class SimOriginDto {
  @IsString() kind!: string;
  @IsString() id!: string;
  @IsOptional() @IsString() reference?: string;
}

class SimCustomerDto {
  @IsString() name!: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() languagePref?: string;
  @IsOptional() @IsIn(["B2C", "B2B"]) segment?: "B2C" | "B2B";
}

class SimFailureDto {
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsString() description?: string;
}

/**
 * The simulator's door into ingestion.
 *
 * Validated exactly as strictly as a real webhook: the simulator gets no
 * shortcut into the system it is meant to be measuring.
 */
export class SimEventDto {
  @IsOptional() @IsString() eventId?: string;
  @IsOptional() @IsString() eventType?: string;

  @IsIn(CASE_TYPES) caseType!: (typeof CASE_TYPES)[number];

  @IsInt() @Min(1) amountPaise!: number;
  @IsOptional() @IsString() currency?: string;

  @ValidateNested() @Type(() => SimOriginDto) @IsObject() origin!: SimOriginDto;
  @ValidateNested() @Type(() => SimCustomerDto) @IsObject() customer!: SimCustomerDto;

  @IsOptional() @ValidateNested() @Type(() => SimFailureDto) failure?: SimFailureDto;

  @IsOptional() @IsString() instrument?: string;
  @IsOptional() @IsISO8601() occurredAt?: string;
  @IsOptional() @IsISO8601() deadlineAt?: string;
}
