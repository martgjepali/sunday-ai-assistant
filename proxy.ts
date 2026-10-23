import { NextResponse, type NextRequest } from "next/server";

/**
 * SUNDAY's API can move files and launch programs, so only SUNDAY's own UI may
 * call it. A custom header can't be sent cross-origin without a CORS preflight
 * (which we never approve), and the Host check stops DNS-rebinding tricks.
 * The Google pages are plain navigations and carry no header.
 */
const OPEN_PATHS = new Set(["/api/google/auth", "/api/google/callback"]);
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function proxy(req: NextRequest) {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  if (!LOCAL_HOSTS.has(host)) return new NextResponse("Forbidden", { status: 403 });

  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (!LOCAL_HOSTS.has(new URL(origin).hostname)) return new NextResponse("Forbidden", { status: 403 });
    } catch {
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  if (!OPEN_PATHS.has(req.nextUrl.pathname) && req.headers.get("x-sunday-client") !== "1") {
    return new NextResponse("Forbidden", { status: 403 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
