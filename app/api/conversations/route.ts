import { connection, type NextRequest } from "next/server";
import { listConversations, messagesFor } from "@/lib/server/memory";

export async function GET(req: NextRequest) {
  await connection();
  const id = req.nextUrl.searchParams.get("id");
  if (id) return Response.json({ messages: messagesFor(id) });
  return Response.json({ conversations: listConversations() });
}
