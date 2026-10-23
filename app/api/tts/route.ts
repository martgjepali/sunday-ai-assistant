import { z } from "zod";
import { elevenVoiceId, withVoiceSlot } from "@/lib/server/voice";

const Body = z.object({ text: z.string().trim().min(1).max(2000) });

/** Streams one chunk of SUNDAY's ElevenLabs voice as MP3. */
export async function POST(req: Request) {
  if (!process.env.ELEVENLABS_API_KEY) return Response.json({ error: "ElevenLabs not configured" }, { status: 501 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Bad request" }, { status: 400 });

  let voiceId: string;
  try {
    voiceId = await elevenVoiceId();
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }

  return withVoiceSlot(req.signal, async () => {
    // ElevenLabs answers 429 when the plan's concurrent-request cap is hit; back off briefly.
    for (let attempt = 0; ; attempt++) {
      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128&optimize_streaming_latency=3`,
        {
          method: "POST",
          signal: req.signal,
          headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY!, "Content-Type": "application/json" },
          body: JSON.stringify({
            text: parsed.data.text,
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
        return Response.json(
          { error: `ElevenLabs ${upstream.status}: ${(await upstream.text()).slice(0, 200)}` },
          { status },
        );
      }
      return upstream;
    }
  });
}
