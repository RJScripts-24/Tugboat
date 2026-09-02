import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

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

  /**
   * Only meaningful on `call`: the merchant has been shown which bounds are
   * holding the rung and has said go anyway (D-160).
   *
   * A flag rather than a list of rules to waive, because the merchant is
   * answering the question the preview asked and the gate is the thing that
   * decides what that covers. A body that named its own rules would be a body
   * that could name `Opt-out`.
   */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
