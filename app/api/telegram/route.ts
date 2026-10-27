import { z } from "zod";
import { startPairing, telegramStatus, unpair } from "@/lib/server/telegram";

const Body = z.object({ action: z.enum(["pair", "unpair"]) });

/** POST {action:"pair"} → a one-time code to send to the bot.  {action:"unpair"} forgets the paired phone. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Bad request" }, { status: 400 });
  try {
    if (parsed.data.action === "unpair") {
      unpair();
      return Response.json(telegramStatus());
    }
    return Response.json(startPairing());
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
