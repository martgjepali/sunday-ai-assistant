import { connection } from "next/server";
import { features } from "@/lib/server/config";
import { googleAuthUrl } from "@/lib/server/tools/gmail";

export async function GET() {
  await connection();
  if (!features.google()) {
    return new Response("Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env, then restart SUNDAY.", { status: 501 });
  }
  return Response.redirect(googleAuthUrl(), 302);
}
