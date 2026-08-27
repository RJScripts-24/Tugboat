import { IsOptional, IsString, MaxLength } from "class-validator";

/**
 * An override carries at most a note.
 *
 * Who did it is taken from the session rather than from the body: a field
 * naming the actor would be a field a caller could forge, and the whole value
 * of a HUMAN ledger row is that the name on it is the name that signed in.
 */
export class OverrideCaseDto {
  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;
}
