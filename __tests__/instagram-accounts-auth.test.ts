import { describe, expect, it } from "vitest";
import { serviceTokenMatches } from "@/lib/service-auth";

/**
 * `serviceTokenMatches` takes the whole Authorization header, prefix included.
 *
 * The instagram-accounts route stripped "Bearer " before calling it, so every
 * request came back Unauthorized even with the right token. The helper's
 * contract is easy to get backwards, and nothing in its name says which half
 * it wants, so it is worth pinning.
 */
describe("service token contract", () => {
  const env = { PROMPT_SYSTEM_API_TOKEN: "segredo-de-teste" };

  it("accepts the full header", () => {
    expect(serviceTokenMatches("Bearer segredo-de-teste", env)).toBe(true);
  });

  it("rejects the bare token, without the prefix", () => {
    // This is exactly what the broken route was passing.
    expect(serviceTokenMatches("segredo-de-teste", env)).toBe(false);
  });

  it("rejects a wrong token of the same length", () => {
    expect(serviceTokenMatches("Bearer segredo-de-testX", env)).toBe(false);
  });

  it("rejects everything when the token is not configured", () => {
    expect(serviceTokenMatches("Bearer qualquer-coisa", {})).toBe(false);
  });
});
