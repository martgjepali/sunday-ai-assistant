import { connection } from "next/server";
import { z } from "zod";
import { answerApproval, codingState, dismissCoding, stopCoding } from "@/lib/server/coder";

/** GET → the coding task the panel shows. POST → sir's buttons: allow / deny a command, stop, dismiss. */
export async function GET() {
  await connection();
  return Response.json(codingState());
}

const Body = z.object({ action: z.enum(["allow", "deny", "stop", "dismiss"]) });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Bad request" }, { status: 400 });
  try {
    const a = parsed.data.action;
    if (a === "allow" || a === "deny") answerApproval(a === "allow");
    else if (a === "stop") stopCoding();
    else dismissCoding();
    return Response.json(codingState());
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
