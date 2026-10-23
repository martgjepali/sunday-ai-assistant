import { z } from "zod";
import { judge, typesafeEnabled } from "@/lib/server/typesafe";

const Body = z.object({
  heard: z.string().trim().min(1).max(500),
  speaking: z.string().max(1000).default(""),
});

/**
 * While SUNDAY is talking: does what the mic just heard mean "stop and listen"
 * (a correction, a new command) or is it a backchannel ("mm-hm", "okay") or
 * an echo of her own voice? Returns the probability of a real interruption.
 */
export async function POST(req: Request) {
  if (!typesafeEnabled()) return Response.json({ enabled: false, interrupt: null });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Bad request" }, { status: 400 });

  try {
    const { answers } = await judge(
      { assistant_is_saying: parsed.data.speaking, microphone_heard: parsed.data.heard },
      {
        interrupt: {
          type: "noul",
          instructions:
            "While the voice assistant was speaking (`assistant_is_saying`), the microphone picked up `microphone_heard`. " +
            "Does the user want the assistant to stop talking and listen — a correction, objection, question or new instruction?",
          criteria: {
            true: "The user is interrupting: e.g. 'wait', 'stop', 'no, not that one', 'open Chrome instead', or a new question.",
            false:
              "Not an interruption: a backchannel or agreement like 'mm-hm', 'yeah', 'okay', 'right', background noise, " +
              "or the assistant's own words echoed back.",
          },
        },
      },
      { timeoutMs: 2500, signal: req.signal },
    );
    const a = answers.interrupt;
    return Response.json({ enabled: true, interrupt: a.type === "noul" ? a.noul : null });
  } catch (err) {
    // Never block the conversation on a judgment failure; the client falls back to its simple rule.
    return Response.json({ enabled: true, interrupt: null, error: err instanceof Error ? err.message : String(err) });
  }
}
