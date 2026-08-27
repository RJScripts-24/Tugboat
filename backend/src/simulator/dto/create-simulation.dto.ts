import { Type } from "class-transformer";
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

const DIFFICULTIES = ["easy", "realistic", "hostile"] as const;
const ARMS = ["baseline", "naive", "tugboat"] as const;

class MixDto {
  @IsNumber() @Min(0) @Max(100) PAYMENT_FAILED!: number;
  @IsNumber() @Min(0) @Max(100) CHECKOUT_ABANDONED!: number;
  @IsNumber() @Min(0) @Max(100) MANDATE_FAILED!: number;
  @IsNumber() @Min(0) @Max(100) INVOICE_OVERDUE!: number;
}

/**
 * `POST /simulations`, matching the lab's `SimulationConfig` field for field.
 *
 * The upper bound on `batchSize` is a real limit rather than a round number:
 * every case in a run is a live row with its own event log and its own ledger
 * chain, and a thousand of them against a free-tier database is a run that
 * outlives the demo it was started for.
 */
export class CreateSimulationDto {
  @IsInt() @Min(10) @Max(500) batchSize!: number;

  @IsObject() @ValidateNested() @Type(() => MixDto) mix!: MixDto;

  @IsIn(DIFFICULTIES) difficulty!: (typeof DIFFICULTIES)[number];

  @IsInt() @Min(0) @Max(2_147_483_647) seed!: number;

  @IsArray() @ArrayNotEmpty() @IsIn(ARMS, { each: true }) arms!: (typeof ARMS)[number][];
}
