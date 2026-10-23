import { connection } from "next/server";
import { buildBrain } from "@/lib/server/brain";

export async function GET() {
  await connection();
  return Response.json(await buildBrain(), { headers: { "Cache-Control": "no-store" } });
}
