import { z } from "zod";
import { kokoroAvailable, kokoroSpeak } from "@/lib/server/kokoro";
import { elevenVoiceId, voiceEngine, withVoiceSlot } from "@/lib/server/voice";

const Body = z.object({ text: z.string().trim().min(1).max(2000) });

/**
 * One chunk of SUNDAY's voice: Kokoro (free, on this PC) as WAV, or ElevenLabs as MP3 when sir
 * prefers it — falling back to Kokoro when ElevenLabs is out of credits or unreachable.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Bad request" }, { status: 400 });
  const text = parsed.data.text;
  const engine = voiceEngine();
  if (engine === "browser") return Response.json({ error: "No voice engine set up" }, { status: 501 });

  if (engine === "elevenlabs") {
    const res = await eleven(text, req.signal);
    if (res.ok || !kokoroAvailable() || req.signal.aborted) return res;
    console.warn("[sunday] ElevenLabs failed, speaking with Kokoro:", ((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status);
  }
  return kokoro(text, req.signal);
}

async function kokoro(text: string, signal: AbortSignal) {
  try {
    const audio = await kokoroSpeak(text, signal);
    if (!audio) return new Response(null, { status: signal.aborted ? 499 : 204 });
    return new Response(new Uint8Array(audio), { headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[sunday] Kokoro voice failed:", err);
    return Response.json({ error: `Kokoro voice failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }
}

async function eleven(text: string, signal: AbortSignal): Promise<Response> {
  let voiceId: string;
  try {
    voiceId = await elevenVoiceId();
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }

  return withVoiceSlot(signal, async () => {
    // ElevenLabs answers 429 when the plan's concurrent-request cap is hit; back off briefly.
    for (let attempt = 0; ; attempt++) {
      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128&optimize_streaming_latency=3`,
        {
          method: "POST",
          signal,
          headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY!, "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            model_id: process.env.ELEVENLABS_MODEL ?? "eleven_flash_v2_5",
            voice_settings: { stability: 0.45, similarity_boost: 0.85, style: 0.15, use_speaker_boost: true },
          }),
        },
      );
      if (upstream.status === 429 && attempt < 3) {
        await upstream.body?.cancel();
        await new Promise((r) => setTimeout(r, 350 * 2 ** attempt));
        continue;
      }
      if (!upstream.ok || !upstream.body) {
        const status = upstream.status === 401 || upstream.status === 403 ? upstream.status : 502;
        const detail = await upstream.text();
        // Out of monthly credits: say so plainly instead of dumping ElevenLabs' JSON.
        if (detail.includes("quota_exceeded")) {
          return Response.json({ error: "ElevenLabs credits are used up for this month." }, { status });
        }
        return Response.json({ error: `ElevenLabs ${upstream.status}: ${detail.slice(0, 200)}` }, { status });
      }
      return upstream;
    }
  });
}
