import { hashPassword, verifyPassword } from "./password";

describe("password", () => {
  it("accepts the correct password", async () => {
    const stored = await hashPassword("tugboat-demo");
    await expect(verifyPassword("tugboat-demo", stored)).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("tugboat-demo");
    await expect(verifyPassword("tugboat-dem0", stored)).resolves.toBe(false);
  });

  it("salts, so the same password hashes differently every time", async () => {
    const a = await hashPassword("same-input");
    const b = await hashPassword("same-input");

    expect(a).not.toBe(b);
    await expect(verifyPassword("same-input", a)).resolves.toBe(true);
    await expect(verifyPassword("same-input", b)).resolves.toBe(true);
  });

  it("records its parameters so a future cost increase stays verifiable", async () => {
    const stored = await hashPassword("x");
    expect(stored.split("$").slice(0, 4)).toEqual(["scrypt", "16384", "8", "1"]);
  });

  it("rejects a malformed stored hash instead of throwing", async () => {
    await expect(verifyPassword("x", "not-a-hash")).resolves.toBe(false);
    await expect(verifyPassword("x", "bcrypt$1$2$3$4$5")).resolves.toBe(false);
  });
});
