import { connection, type NextRequest } from "next/server";
import {
  enrollAdd,
  enrollRemove,
  enrollReset,
  enrollSave,
  modelAvailable,
  ownerRecentlyHeard,
  ownerVoice,
  pcmToFloat,
  verify,
  voiceIdDisabled,
} from "@/lib/server/speaker";

/** Changing the voiceprint is only allowed before enrollment or right after sir was recognised. */
const canManage = () => !ownerVoice() || ownerRecentlyHeard();

export async function GET() {
  await connection();
  const owner = ownerVoice();
  return Response.json({
    enrolled: Boolean(owner),
    enrolledAt: owner?.enrolledAt ?? null,
    modelReady: modelAvailable(),
    disabledByEnv: voiceIdDisabled(),
  });
}

/**
 * POST ?action=verify        body: 16 kHz mono 16-bit PCM → { owner, token, similarity }
 * POST ?action=enroll-start  → begin a new recording set
 * POST ?action=enroll-add    body: PCM clip → { ok, count, problem? }
 * POST ?action=enroll-save   → { ok, error? }
 */
export async function POST(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");
  try {
    if (action === "verify") {
      return Response.json(verify(pcmToFloat(await req.arrayBuffer())));
    }
    if (!canManage()) {
      return Response.json(
        { ok: false, error: "Say something to me first so I know it's you, then try again." },
        { status: 403 },
      );
    }
    if (action === "enroll-start") {
      enrollReset();
      return Response.json({ ok: true });
    }
    if (action === "enroll-add") return Response.json(enrollAdd(pcmToFloat(await req.arrayBuffer())));
    if (action === "enroll-save") return Response.json(enrollSave());
    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function DELETE() {
  if (!canManage()) return Response.json({ ok: false, error: "Only sir can remove Voice ID." }, { status: 403 });
  enrollRemove();
  return Response.json({ ok: true });
}
