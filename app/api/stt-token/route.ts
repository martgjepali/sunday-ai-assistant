/**
 * Short-lived Deepgram credential for the browser's streaming connection.
 * Falls back to the project key itself (this server only listens on 127.0.0.1)
 * when the key isn't allowed to mint temporary tokens.
 */
export async function POST() {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return Response.json({ error: "Deepgram not configured" }, { status: 501 });
  try {
    const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl_seconds: 600 }),
    });
    if (res.ok) {
      const { access_token } = (await res.json()) as { access_token: string };
      return Response.json({ scheme: "bearer", token: access_token });
    }
  } catch {}
  return Response.json({ scheme: "token", token: key });
}
