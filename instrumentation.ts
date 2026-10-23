export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startIndexer } = await import("./lib/server/indexer");
  startIndexer();
}
