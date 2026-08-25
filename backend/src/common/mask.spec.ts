import { maskEmail, maskPhone, maskedContact } from "./mask";

describe("mask", () => {
  it("keeps a phone recognisable to its owner and useless to anyone else", () => {
    expect(maskPhone("9822010210")).toBe("98•••••210");
  });

  it("strips formatting before masking, so the shape is stable", () => {
    expect(maskPhone("+91 98220-10210")).toBe("91•••••210");
  });

  it("keeps the email domain, which is what identifies a B2B account", () => {
    expect(maskEmail("ops@kettleandco.in")).toBe("o•••••@kettleandco.in");
  });

  it("refuses to half-mask something too short to hide", () => {
    expect(maskPhone("123")).toBe("•••••");
    expect(maskEmail("@nope")).toBe("•••••");
    expect(maskEmail("no-at-sign")).toBe("•••••");
  });

  it("prefers a phone, falls back to an email, and never returns nothing", () => {
    expect(maskedContact({ maskedPhone: "98•••••210", maskedEmail: "o•••••@x.in" })).toBe(
      "98•••••210",
    );
    expect(maskedContact({ maskedPhone: null, maskedEmail: "o•••••@x.in" })).toBe("o•••••@x.in");
    expect(maskedContact({ maskedPhone: null, maskedEmail: null })).toBe("—");
  });
});
