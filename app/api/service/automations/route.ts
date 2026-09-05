import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import {
  isServiceApiEnabled,
  keywordCollides,
  serviceKeywordSchema,
  serviceTokenMatches,
} from "@/lib/service-auth";
import { generateReportShareSlug } from "@/lib/reports/share";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";

/**
 * Machine-to-machine endpoint for creating campaigns from another service.
 *
 * The existing `POST /api/automations` is authenticated by a browser session,
 * so a backend cannot call it. This route is additive — it does not change any
 * existing behaviour — and is authenticated by a single static token instead.
 *
 * It exists for a content pipeline that publishes to the same Instagram
 * account this instance already listens to: the pipeline picks a keyword,
 * creates the campaign here, and then publishes the post carrying that
 * keyword. Doing it by hand for every post does not scale, and writing
 * straight into the database would skip the validation and the tracked-link
 * generation that live in this layer.
 *
 * Two things worth knowing if you review this:
 *
 * 1. **Off by default.** With no `PROMPT_SYSTEM_API_TOKEN` set, every request
 *    gets 503. An unset secret must never mean an open endpoint.
 * 2. **Workspace and Instagram account are resolved, not assumed.** When the
 *    instance has more than one of either, the request must name which — a
 *    wrong guess would send DMs from the wrong profile, which is not something
 *    you can take back.
 */

export const dynamic = "force-dynamic";

const KEYWORD = serviceKeywordSchema;

const createSchema = z.object({
  keyword: KEYWORD,
  name: z.string().trim().min(1).max(100).optional(),
  postId: z.string().trim().min(1).optional().nullable(),
  postUrl: z.string().url().optional().nullable(),
  dmMessage: z.string().trim().min(1).max(1000),
  openingDmMessage: z.string().max(1000).optional().nullable(),
  openingDmButtonLabel: z.string().max(64).optional().nullable(),
  linkButtonLabel: z.string().max(20).optional().nullable(),
  publicReplyMessages: z.array(z.string().max(1000)).max(10).optional().default([]),
  requireFollow: z.boolean().optional().default(false),
  followUpEnabled: z.boolean().optional().default(false),
  followUpMessage: z.string().max(1000).optional().nullable(),
  followUpDelayMinutes: z.number().int().min(0).max(1440).optional().default(0),
  trackedLink: z
    .object({
      destinationUrl: z.string().url(),
      label: z.string().max(100).optional().nullable(),
      slug: z.string().trim().min(3).max(64).optional(),
    })
    .optional(),
  workspaceId: z.string().min(1).optional(),
  instagramAccountId: z.string().min(1).optional(),
});

function unauthorized() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

function serviceDisabled(): NextResponse | null {
  if (isServiceApiEnabled()) return null;

  return NextResponse.json(
    {
      success: false,
      error: "Service API is disabled. Set PROMPT_SYSTEM_API_TOKEN to enable it.",
    },
    { status: 503 },
  );
}

/**
 * Keyword availability.
 *
 * `200` when free, `409` when some campaign already uses it. The caller needs
 * this before publishing: two live campaigns sharing a keyword make the worker
 * pick one arbitrarily, and the other post silently stops delivering.
 *
 * Matching is case-insensitive because the worker matches comments that way —
 * checking case-sensitively here would report a keyword as free that is not.
 */
export async function GET(request: NextRequest) {
  const disabled = serviceDisabled();
  if (disabled) return disabled;
  if (!serviceTokenMatches(request.headers.get("authorization"))) return unauthorized();

  const raw = request.nextUrl.searchParams.get("keyword");
  const parsed = KEYWORD.safeParse(raw ?? "");

  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid keyword", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const keyword = parsed.data;

  const existing = await prisma.automation.findFirst({
    where: { keywords: { has: keyword } },
    select: { id: true, name: true, isActive: true },
  });

  // Postgres array `has` is exact, so a differently-cased duplicate would slip
  // through. The extra scan is cheap and closes that gap.
  const caseInsensitive =
    existing ??
    (
      await prisma.automation.findMany({
        where: { keywords: { isEmpty: false } },
        select: { id: true, name: true, isActive: true, keywords: true },
      })
    ).find((a) => keywordCollides(a.keywords, keyword)) ??
    null;

  if (caseInsensitive) {
    return NextResponse.json(
      {
        success: false,
        available: false,
        error: "Keyword already in use",
        automation: {
          id: caseInsensitive.id,
          name: caseInsensitive.name,
          isActive: caseInsensitive.isActive,
        },
      },
      { status: 409 },
    );
  }

  return NextResponse.json({ success: true, available: true, keyword });
}

export async function POST(request: NextRequest) {
  const disabled = serviceDisabled();
  if (disabled) return disabled;
  if (!serviceTokenMatches(request.headers.get("authorization"))) return unauthorized();

  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const data = parsed.data;

  // Resolve the workspace. Picking one when several exist would create the
  // campaign in the wrong place, and there is no signal in the request to
  // guess from.
  const workspace = data.workspaceId
    ? await prisma.workspace.findUnique({ where: { id: data.workspaceId }, select: { id: true } })
    : await (async () => {
        const all = await prisma.workspace.findMany({ select: { id: true }, take: 2 });
        return all.length === 1 ? all[0] : null;
      })();

  if (!workspace) {
    // The count turns one ambiguous message into two actionable ones. Zero
    // means nobody has signed in yet, since the workspace is created on first
    // sign-in; more than one means the caller has to choose. The old wording
    // covered both and helped with neither.
    const total = await prisma.workspace.count();

    return NextResponse.json(
      {
        success: false,
        workspaceCount: total,
        error:
          total === 0
            ? "No workspace exists yet. Sign in to OpenReply once to create one, then retry."
            : `Found ${total} workspaces. Pass workspaceId to choose one.`,
      },
      { status: 400 },
    );
  }

  const instagramAccount = data.instagramAccountId
    ? await prisma.instagramAccount.findFirst({
        where: { id: data.instagramAccountId, workspaceId: workspace.id },
      })
    : await (async () => {
        const accounts = await prisma.instagramAccount.findMany({
          where: { workspaceId: workspace.id },
          orderBy: { connectedAt: "desc" },
          take: 2,
        });
        // Same reasoning as the workspace, and it matters more here: sending
        // DMs from the wrong profile is not something you can take back.
        return accounts.length === 1 ? accounts[0] : null;
      })();

  if (!instagramAccount) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Could not resolve an Instagram account. Connect one, or pass " +
          "instagramAccountId when the workspace has more than one.",
      },
      { status: 400 },
    );
  }

  const conflict = await prisma.automation.findFirst({
    where: { keywords: { has: data.keyword } },
    select: { id: true },
  });

  if (conflict) {
    return NextResponse.json(
      { success: false, error: "Keyword already in use", automation: { id: conflict.id } },
      { status: 409 },
    );
  }

  const publicReplies = data.publicReplyMessages.map((m) => m.trim()).filter(Boolean);
  const openingDm = data.openingDmMessage?.trim() || null;

  const automation = await prisma.automation.create({
    data: {
      name: data.name?.trim() || `UltraPrompt ${data.keyword}`,
      goal: "leads",
      postId: data.postId || null,
      postUrl: data.postUrl || null,
      matchAnyPost: !data.postId,
      keywords: [data.keyword],
      matchAnyWord: false,
      wholeWordMatch: true,
      dmTriggerEnabled: false,
      dmMessage: data.dmMessage.trim(),
      openingDmEnabled: Boolean(openingDm),
      openingDmMessage: openingDm,
      openingDmButtonLabel: data.openingDmButtonLabel?.trim() || null,
      linkButtonLabel: data.linkButtonLabel?.trim() || null,
      requireFollow: data.requireFollow,
      followUpEnabled: data.followUpEnabled,
      followUpMessage: data.followUpEnabled ? data.followUpMessage?.trim() || null : null,
      followUpDelayMinutes: data.followUpEnabled ? data.followUpDelayMinutes : 0,
      publicReplyEnabled: publicReplies.length > 0,
      publicReplyMessages: publicReplies,
      publicReplyMessage: publicReplies[0] ?? null,
      isActive: true,
      workspaceId: workspace.id,
      instagramAccountId: instagramAccount.id,
      reportShareSlug: generateReportShareSlug(),
      ...(data.trackedLink
        ? {
            trackedLinks: {
              create: {
                workspaceId: workspace.id,
                slug: data.trackedLink.slug?.trim() || generateTrackedLinkSlug(),
                label: data.trackedLink.label?.trim() || null,
                destinationUrl: data.trackedLink.destinationUrl,
              },
            },
          }
        : {}),
    },
    include: { trackedLinks: true },
  });

  return NextResponse.json({ success: true, data: automation }, { status: 201 });
}
