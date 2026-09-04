import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Authentication for the machine-to-machine service API.
 *
 * A single static token, kept out of the browser entirely. It guards the only
 * route that can create a campaign without a signed-in session, so the two
 * rules below are not negotiable:
 *
 * 1. **An unset secret disables the API.** It must never mean "open".
 * 2. **Comparison is constant-time.** A length-dependent early return would
 *    leak the token length, and the token is the whole guard.
 */

/** Keyword shape the service API accepts. */
export const serviceKeywordSchema = z
  .string()
  .trim()
  .min(3)
  .max(50)
  .regex(/^[A-Za-z0-9]+$/, "keyword must be letters and digits only");

export function isServiceApiEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env.PROMPT_SYSTEM_API_TOKEN?.trim());
}

export function serviceTokenMatches(
  authorizationHeader: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const expected = env.PROMPT_SYSTEM_API_TOKEN?.trim();
  if (!expected) return false;
  if (!authorizationHeader?.startsWith("Bearer ")) return false;

  const provided = Buffer.from(authorizationHeader.slice(7).trim());
  const wanted = Buffer.from(expected);

  // timingSafeEqual throws on length mismatch, so the length check has to come
  // first. It leaks only the length, which the caller already controls.
  if (provided.length !== wanted.length) return false;

  return timingSafeEqual(provided, wanted);
}

/** True when the keyword is already taken, comparing case-insensitively. */
export function keywordCollides(existing: string[], candidate: string): boolean {
  const alvo = candidate.trim().toLowerCase();
  return existing.some((k) => k.trim().toLowerCase() === alvo);
}
