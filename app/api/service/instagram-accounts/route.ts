import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import {
  getUserInfo,
  subscribeInstagramAccountToWebhooks,
} from "@/lib/meta/client";
import { isServiceApiEnabled, serviceTokenMatches } from "@/lib/service-auth";

/**
 * Connect an Instagram account from a long-lived token, without the OAuth
 * dance.
 *
 * The browser flow is the normal path and stays the normal path. This exists
 * for the case where it cannot complete: a Meta app whose redirect URI is not
 * whitelisted, or an app still in development mode, both of which show the
 * user a bare "this page isn't available" and give the operator nothing to act
 * on. When the token already exists elsewhere (a publishing pipeline, say),
 * refusing to accept it means the whole product is blocked on a Meta console
 * setting.
 *
 * The token is not trusted blindly. `getUserInfo` is called first, and the
 * account identity comes from what Instagram answers, never from the request
 * body. A caller cannot register someone else's username against their token.
 *
 * Webhook subscription is part of connecting, not an extra step. Without
 * `comments` and `messages` subscribed, the account exists in the database and
 * no comment ever arrives, which looks exactly like a broken automation and is
 * far harder to diagnose than a failed connect.
 */

const BodySchema = z.object({
  accessToken: z.string().trim().min(20),
  workspaceId: z.string().trim().min(1).optional(),
  /** Seconds until the token expires, when the caller knows it. */
  expiresIn: z.number().int().positive().optional(),
});

function unauthorized() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function POST(req: NextRequest) {
  if (!isServiceApiEnabled()) {
    return NextResponse.json(
      { success: false, error: "Service API disabled" },
      { status: 503 },
    );
  }

  // The whole header, prefix included: `serviceTokenMatches` checks for
  // "Bearer " itself and rejects anything without it. Stripping the prefix
  // here made every call unauthorized.
  if (!serviceTokenMatches(req.headers.get("authorization"))) return unauthorized();

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid body", issues: parsed.error.issues.slice(0, 5) },
      { status: 400 },
    );
  }

  const { accessToken, expiresIn } = parsed.data;

  // Same reasoning as the automations route: picking one workspace when
  // several exist would put the account in the wrong place, and there is no
  // signal in the request to guess from.
  const workspace = parsed.data.workspaceId
    ? await prisma.workspace.findUnique({
        where: { id: parsed.data.workspaceId },
        select: { id: true },
      })
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

  let perfil: { id: string; username: string; name?: string };
  try {
    // The identity comes from Instagram, not from the request body.
    perfil = (await getUserInfo(accessToken)) as unknown as {
      id: string;
      username: string;
      name?: string;
    };
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: `Token rejected by Instagram: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 400 },
    );
  }

  if (!perfil?.id || !perfil?.username) {
    return NextResponse.json(
      { success: false, error: "Instagram did not return an account id and username." },
      { status: 400 },
    );
  }

  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

  const conta = await prisma.instagramAccount.upsert({
    where: { instagramId: perfil.id },
    create: {
      workspaceId: workspace.id,
      instagramId: perfil.id,
      username: perfil.username,
      name: perfil.name ?? null,
      accessToken,
      tokenExpiresAt: expiresAt,
    },
    // Reconnecting the same account refreshes the token instead of failing on
    // the unique constraint. Rotating a token is the common case, not an edge.
    update: {
      workspaceId: workspace.id,
      username: perfil.username,
      name: perfil.name ?? null,
      accessToken,
      tokenExpiresAt: expiresAt,
    },
  });

  let webhook = false;
  let webhookError: string | null = null;
  try {
    const r = await subscribeInstagramAccountToWebhooks(perfil.id, accessToken);
    webhook = Boolean(r?.success);
  } catch (err) {
    webhookError = err instanceof Error ? err.message : String(err);
  }

  if (webhook) {
    await prisma.instagramAccount.update({
      where: { id: conta.id },
      data: { webhookSubscribed: true },
    });
  }

  return NextResponse.json({
    success: true,
    account: {
      id: conta.id,
      instagramId: conta.instagramId,
      username: conta.username,
      workspaceId: conta.workspaceId,
    },
    // Reported, never silent: an account without the subscription looks
    // connected and answers nothing.
    webhookSubscribed: webhook,
    ...(webhookError ? { webhookError } : {}),
  });
}

/** Lists connected accounts, so the caller can pass the right id. */
export async function GET(req: NextRequest) {
  if (!isServiceApiEnabled()) {
    return NextResponse.json(
      { success: false, error: "Service API disabled" },
      { status: 503 },
    );
  }

  // The whole header, prefix included: `serviceTokenMatches` checks for
  // "Bearer " itself and rejects anything without it. Stripping the prefix
  // here made every call unauthorized.
  if (!serviceTokenMatches(req.headers.get("authorization"))) return unauthorized();

  const contas = await prisma.instagramAccount.findMany({
    select: {
      id: true,
      instagramId: true,
      username: true,
      workspaceId: true,
      webhookSubscribed: true,
      connectedAt: true,
    },
    orderBy: { connectedAt: "desc" },
  });

  return NextResponse.json({ success: true, accounts: contas });
}
