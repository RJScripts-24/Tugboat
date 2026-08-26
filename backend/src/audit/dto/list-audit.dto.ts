import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

const ACTORS = ["BOA", "POLICY", "HUMAN", "SYSTEM"] as const;

/** `?actor=a&actor=b` and `?actor=a,b` both arrive as a list. */
const toArray = ({ value }: { value: unknown }): string[] | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(",");
  return raw.map((entry) => String(entry).trim()).filter(Boolean);
};

export class ListAuditDto {
  /** `?case=C-1042` — how Case Detail and the Approvals Queue point at their rows. */
  @IsOptional() @IsString() case?: string;

  @IsOptional() @IsString() chain?: string;

  @IsOptional()
  @Transform(toArray)
  @IsIn(ACTORS, { each: true })
  actor?: (typeof ACTORS)[number][];

  @IsOptional()
  @Transform(toArray)
  @IsString({ each: true })
  action?: string[];

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) fromMs?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) toMs?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) skip?: number;
  // The Audit Explorer virtualises its table, so it asks for large pages.
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(2000) take?: number;
}

export class VerifyChainDto {
  /** Verify one chain rather than all of them — a case reference, or "policy". */
  @IsOptional() @IsString() chain?: string;
}
