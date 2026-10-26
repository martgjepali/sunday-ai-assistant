import { connection } from "next/server";
import { brainMode, localBrainStatus } from "@/lib/server/brains";
import { EFFORT, FAST_MODEL, LOCAL_BASE_MODEL, MODEL, driveRoots, features } from "@/lib/server/config";
import { indexerStatus } from "@/lib/server/indexer";
import { gmailAccount } from "@/lib/server/tools/gmail";
import { typesafeEnabled } from "@/lib/server/typesafe";
import { voiceStatus, wakeWordConfig } from "@/lib/server/voice";

export async function GET() {
  await connection();
  return Response.json({
    model: MODEL,
    effort: EFFORT,
    brain: features.anthropic(),
    brains: { mode: brainMode(), local: { ...(await localBrainStatus()), model: LOCAL_BASE_MODEL }, fast: FAST_MODEL },
    drives: driveRoots(),
    index: indexerStatus(),
    voice: voiceStatus(),
    stt: features.deepgram() ? "deepgram" : "none",
    wake: wakeWordConfig(),
    typesafe: typesafeEnabled(),
    gmail: { configured: features.google(), account: gmailAccount() },
  });
}
