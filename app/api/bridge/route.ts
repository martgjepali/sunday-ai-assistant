import { z } from "zod";
import { fulfill } from "@/lib/server/bridge";

const Body = z.object({ id: z.string().regex(/^[0-9a-f]{24}$/), data: z.unknown() });

/** SUNDAY's window answering a tool's request (see lib/server/bridge.ts). */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Bad request" }, { status: 400 });
  return Response.json({ ok: fulfill(parsed.data.id, parsed.data.data) });
}
