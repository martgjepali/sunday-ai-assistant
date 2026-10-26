import { connection, type NextRequest } from "next/server";
import { claimNotices } from "@/lib/server/notices";
import { claimDue, listReminders } from "@/lib/server/reminders";

/** GET → pending reminders/timers.  POST ?action=claim → everything now due, plus finished background work (each handed out once). */
export async function GET() {
  await connection();
  return Response.json({ reminders: listReminders() });
}

export async function POST(req: NextRequest) {
  if (req.nextUrl.searchParams.get("action") !== "claim") return Response.json({ error: "Unknown action" }, { status: 400 });
  return Response.json({ due: claimDue(), notices: claimNotices() });
}
