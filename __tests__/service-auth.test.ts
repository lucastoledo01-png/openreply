import { describe, expect, it } from "vitest";
import {
  isServiceApiEnabled,
  keywordCollides,
  serviceKeywordSchema,
  serviceTokenMatches,
} from "../lib/service-auth";

const TOKEN = "prompt-system-token-de-teste-1234567890";
const env = { PROMPT_SYSTEM_API_TOKEN: TOKEN };

describe("service API is off unless a token is set", () => {
  it("is disabled with no token", () => {
    expect(isServiceApiEnabled({})).toBe(false);
    expect(isServiceApiEnabled({ PROMPT_SYSTEM_API_TOKEN: "" })).toBe(false);
    expect(isServiceApiEnabled({ PROMPT_SYSTEM_API_TOKEN: "   " })).toBe(false);
  });

  it("is enabled with a token", () => {
    expect(isServiceApiEnabled(env)).toBe(true);
  });

  it("rejects everything while disabled, including a correct-looking header", () => {
    // An unset secret must never mean an open endpoint.
    expect(serviceTokenMatches(`Bearer ${TOKEN}`, {})).toBe(false);
  });
});

describe("token comparison", () => {
  it("accepts the exact token", () => {
    expect(serviceTokenMatches(`Bearer ${TOKEN}`, env)).toBe(true);
  });

  it("tolerates surrounding whitespace in the header", () => {
    expect(serviceTokenMatches(`Bearer   ${TOKEN}  `, env)).toBe(true);
  });

  it("rejects a wrong token of the same length", () => {
    const wrong = "x".repeat(TOKEN.length);
    expect(wrong).toHaveLength(TOKEN.length);
    expect(serviceTokenMatches(`Bearer ${wrong}`, env)).toBe(false);
  });

  it("rejects a prefix, a suffix and a truncation", () => {
    expect(serviceTokenMatches(`Bearer ${TOKEN}extra`, env)).toBe(false);
    expect(serviceTokenMatches(`Bearer ${TOKEN.slice(0, -1)}`, env)).toBe(false);
  });

  it("requires the Bearer scheme", () => {
    expect(serviceTokenMatches(TOKEN, env)).toBe(false);
    expect(serviceTokenMatches(`Token ${TOKEN}`, env)).toBe(false);
    expect(serviceTokenMatches(`bearer ${TOKEN}`, env)).toBe(false);
  });

  it("handles a missing header without throwing", () => {
    expect(serviceTokenMatches(null, env)).toBe(false);
    expect(serviceTokenMatches(undefined, env)).toBe(false);
    expect(serviceTokenMatches("", env)).toBe(false);
    expect(serviceTokenMatches("Bearer ", env)).toBe(false);
  });
});

describe("keyword shape", () => {
  it("accepts letters and digits", () => {
    expect(serviceKeywordSchema.safeParse("GTA26").success).toBe(true);
    expect(serviceKeywordSchema.safeParse("vice26").success).toBe(true);
  });

  it("rejects spaces, accents and punctuation", () => {
    // The worker matches comment text, so a keyword with a space or an accent
    // would produce a post whose call to action never delivers.
    for (const k of ["GTA 26", "AÇÃO", "foto-87", "emoji🙂"]) {
      expect(serviceKeywordSchema.safeParse(k).success, k).toBe(false);
    }
  });

  it("enforces the length bounds", () => {
    expect(serviceKeywordSchema.safeParse("ab").success).toBe(false);
    expect(serviceKeywordSchema.safeParse("a".repeat(51)).success).toBe(false);
    expect(serviceKeywordSchema.safeParse("abc").success).toBe(true);
  });
});

describe("keyword collision", () => {
  it("is case-insensitive, like the comment matcher", () => {
    // Postgres array `has` is exact, so a differently-cased duplicate would be
    // reported as available — and two live campaigns on one keyword make the
    // worker pick one arbitrarily.
    expect(keywordCollides(["gta26"], "GTA26")).toBe(true);
    expect(keywordCollides(["GTA26"], "gta26")).toBe(true);
  });

  it("ignores surrounding whitespace on both sides", () => {
    expect(keywordCollides([" GTA26 "], "gta26")).toBe(true);
  });

  it("does not collide on a different keyword", () => {
    expect(keywordCollides(["GTA26", "VICE26"], "FOTO87")).toBe(false);
    expect(keywordCollides([], "GTA26")).toBe(false);
  });
});
