import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

/**
 * A yes, optionally carrying a rewritten body.
 *
 * The lines are accepted as free text rather than validated against the stored
 * draft: an approver who cannot change the wording is not approving a message,
 * they are clicking a button. The one line they may not remove is put back by
 * the service (D-68), and the bounds below exist so a paste accident cannot
 * push a novel through a WhatsApp template.
 */
export class ApproveApprovalDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(600, { each: true })
  draftLines?: string[];

  @IsOptional() @IsString() @MaxLength(200) draftSubject?: string;
}

/**
 * A no, which needs a reason.
 *
 * Not friction for its own sake: the reason is the only part of a refusal that
 * survives into the evidence report, and a queue of unexplained noes teaches
 * the planner nothing. The gate's own suggestions travel out on the request, but
 * a typed reason is accepted too — refusing an approver's own words would push
 * them toward whichever canned option was closest.
 */
export class RejectApprovalDto {
  @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}
