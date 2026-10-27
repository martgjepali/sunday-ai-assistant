import { connection } from "next/server";
import { z } from "zod";
import { addTasks, changeTask, completeTasks, listTasks } from "@/lib/server/tasks";

/** GET → all lists (open items plus last week's ticked-off ones). POST → add / tick / untick / put away from the Lists panel. */
export async function GET() {
  await connection();
  return Response.json(listTasks({ includeDone: true }));
}

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), list: z.string().max(60).optional(), text: z.string().trim().min(1).max(300) }),
  z.object({ action: z.enum(["done", "undo", "archive"]), id: z.number().int() }),
]);

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Bad request" }, { status: 400 });
  const b = parsed.data;
  try {
    if (b.action === "add") addTasks({ list: b.list, items: [{ text: b.text }] });
    else if (b.action === "archive") changeTask({ ref: b.id, archive: true });
    else completeTasks({ refs: [b.id], undo: b.action === "undo" });
    return Response.json(listTasks({ includeDone: true }));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
