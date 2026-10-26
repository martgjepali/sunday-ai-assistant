// Higgsfield setup check: one Seedance 2.5 text-to-video generation (billable).
// Run: node --env-file=.env.local scripts/higgsfield/index.ts
import { config, higgsfield, HiggsfieldError, type V2Response } from "@higgsfield/client/v2";

const MODEL = "bytedance/seedance-2.5/text-to-video";

if (!process.env.HF_CREDENTIALS?.includes(":")) {
  console.error("HF_CREDENTIALS is missing — add it to .env.local as key-id:key-secret.");
  process.exit(1);
}

// The SDK stops polling only on completed / failed / nsfw, so allow a video enough time.
config({ credentials: process.env.HF_CREDENTIALS, maxPollTime: 15 * 60_000 });

let result: V2Response;
try {
  result = await higgsfield.subscribe(MODEL, {
    input: {
      prompt: "A cinematic scene at sunset",
      duration: 5,
      resolution: "720p",
      aspect_ratio: "16:9",
    },
    withPolling: true,
  });
} catch (err) {
  // A canceled request never reaches a terminal state the SDK knows, so it surfaces as a timeout here.
  const name = err instanceof HiggsfieldError ? err.constructor.name : "Error";
  console.error(`Generation did not complete (${name}): ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const status = result.status as string;
if (status === "completed" && result.video?.url) {
  console.log(`completed — request ${result.request_id}`);
  console.log(result.video.url);
} else if (status === "nsfw") {
  console.error(`Moderated (nsfw) — request ${result.request_id}. Nothing was generated and it isn't charged.`);
  process.exit(1);
} else if (status === "canceled" || status === "failed") {
  console.error(`Request ${result.request_id} ${status}. No video.`);
  process.exit(1);
} else {
  console.error(`Request ${result.request_id} ended as "${status}" without a video URL.`);
  process.exit(1);
}
