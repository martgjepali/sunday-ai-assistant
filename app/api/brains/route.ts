import { connection } from "next/server";
import { z } from "zod";
import { brainMode, setBrainMode } from "@/lib/server/brains";
import { brainDiagnostics } from "@/lib/server/diagnostics";

/** GET → brain mode + full diagnostics.  POST {mode} → pin a brain or go back to "auto". */
export async function GET() {
  await connection();
  return Response.json({ mode: brainMode(), diagnostics: await brainDiagnostics() });
}

const Body = z.object({ mode: z.enum(["auto", "local", "fast", "deep"]) });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "mode must be auto, local, fast or deep" }, { status: 400 });
  return Response.json({ mode: setBrainMode(parsed.data.mode) });
}
