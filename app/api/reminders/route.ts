import { connection, type NextRequest } from "next/server";
import { calendarAlerts } from "@/lib/server/calendar";
import { claimNotices } from "@/lib/server/notices";
import { reportPresence, sirAway } from "@/lib/server/presence";
import { claimDue, listReminders } from "@/lib/server/reminders";
import { telegramStatus } from "@/lib/server/telegram";

/** GET → pending reminders/timers.  POST ?action=claim → everything now due, plus finished background work (each handed out once). */
export async function GET() {
  await connection();
  return Response.json({ reminders: listReminders() });
}

export async function POST(req: NextRequest) {
  if (req.nextUrl.searchParams.get("action") !== "claim") return Response.json({ error: "Unknown action" }, { status: 400 });
  // The window says how long the PC has been idle; while sir is away his phone gets these instead.
  reportPresence(Number(req.nextUrl.searchParams.get("idle") ?? 0));
  if (sirAway() && telegramStatus().paired) return Response.json({ due: [], notices: [] });
  const soon = calendarAlerts().map((n) => ({ ...n, at: Date.now() }));
  return Response.json({ due: claimDue(), notices: [...claimNotices(), ...soon] });
}
