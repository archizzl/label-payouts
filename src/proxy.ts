import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";

/** Pages anyone can see without signing in. */
const PUBLIC = ["/login", "/signup", "/invite/", "/reset-password", "/robots.txt", "/api/cron/"];

/**
 * A quick first check: no session cookie means not signed in, so go to /login. This only looks at
 * the cookie; real checks (valid session, which account, what role) happen in src/server/context.ts.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p))) return NextResponse.next();
  if (getSessionCookie(request)) return NextResponse.next();
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except the auth API, Next's own files and static assets.
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico)$).*)"],
};
