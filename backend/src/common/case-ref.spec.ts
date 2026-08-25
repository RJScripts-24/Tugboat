import { parseCaseRef, toCaseRef } from "./case-ref";

describe("case-ref", () => {
  it("round-trips an id", () => {
    expect(parseCaseRef(toCaseRef(1042))).toBe(1042);
  });

  it("renders the reference the Control Tower puts in URLs", () => {
    expect(toCaseRef(1042)).toBe("C-1042");
  });

  it("tolerates surrounding whitespace from a path parameter", () => {
    expect(parseCaseRef(" C-7 ")).toBe(7);
  });

  it("returns null for anything that is not a case reference", () => {
    for (const input of ["", "1042", "c-1042", "C-", "C-0", "C--1", "C-1.5", "C-abc", "../etc"]) {
      expect(parseCaseRef(input)).toBeNull();
    }
  });
});
