import { NextResponse, type NextRequest } from "next/server";
import { isMarketingHidden, isMarketingPath } from "@/lib/env";

const PROTECTED_PREFIXES = [
  "/dashboard",
  "/automations",
  "/campaigns",
  "/diagnostics",
  "/inbox",
  "/logs",
  "/overview",
  "/settings",
];

function hasSessionCookie(request: NextRequest): boolean {
  return (
    request.cookies.has("authjs.session-token") ||
    request.cookies.has("__Secure-authjs.session-token") ||
    request.cookies.has("next-auth.session-token") ||
    request.cookies.has("__Secure-next-auth.session-token")
  );
}

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
  const isLogin = pathname === "/login";
  const isAuthenticated = hasSessionCookie(request);

  if (isMarketingHidden() && isMarketingPath(pathname)) {
    const target = isAuthenticated ? "/dashboard" : "/login";
    return NextResponse.redirect(new URL(target, request.url));
  }

  if (isProtected && !isAuthenticated) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isLogin && isAuthenticated) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/dashboard/:path*",
    "/automations/:path*",
    "/campaigns/:path*",
    "/diagnostics/:path*",
    "/inbox/:path*",
    "/logs/:path*",
    "/overview/:path*",
    "/settings/:path*",
    "/login",
    "/comment-link-automation/:path*",
    "/instagram-comment-to-dm-templates/:path*",
    "/instagram-dm-automation-agencies/:path*",
    "/manychat-alternative/:path*",
    "/templates/:path*",
  ],
};
