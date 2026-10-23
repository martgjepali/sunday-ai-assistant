import type { NextRequest } from "next/server";
import { completeGoogleAuth } from "@/lib/server/tools/gmail";

const page = (title: string, body: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#05060a;color:#e7e9f0;font:15px system-ui">
<div style="text-align:center;max-width:420px"><h1 style="font-weight:600;font-size:20px">${title}</h1><p style="color:#8a90a2">${body}</p></div></body>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state") ?? "";
  if (!code) return page("Gmail not connected", "Google didn't return an authorisation code.");
  try {
    const email = await completeGoogleAuth(code, state);
    return page("Gmail connected", `SUNDAY can now read ${escape(email)} and write drafts. You can close this tab.`);
  } catch (err) {
    return page("Gmail not connected", escape(err instanceof Error ? err.message : String(err)));
  }
}
