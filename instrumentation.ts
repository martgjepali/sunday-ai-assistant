export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startIndexer } = await import("./lib/server/indexer");
  startIndexer();
  // Load the local brain into the GPU now, so the first "Hey Sunday" doesn't wait for it.
  const { warmLocal } = await import("./lib/server/brains");
  warmLocal();
}
