import { IsIn, IsISO8601, IsInt, IsOptional, IsString, MaxLength, Min } from "class-validator";

const CHANNELS = ["RETRY", "WHATSAPP", "EMAIL", "VOICE"] as const;

/**
 * An inbound customer reply, arriving through the same door the simulator uses.
 *
 * Real inbound webhooks (Twilio, Resend) land in Stage 10 and normalize into
 * exactly this shape, so the classification and consequence path measured by
 * the batch is the path production takes.
 */
export class SimReplyDto {
  @IsInt() @Min(1) caseId!: number;

  @IsIn(CHANNELS) channel!: (typeof CHANNELS)[number];

  @IsString() @MaxLength(2000) text!: string;

  @IsOptional() @IsISO8601() occurredAt?: string;
}
