import { readFile } from "node:fs/promises";

export async function readV2Evidence(file, predicate = () => true) {
  const deadline = Date.now() + 5_000;
  while (true) {
    let evidence;
    try {
      evidence = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (evidence && predicate(evidence)) return evidence;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for OpenCode v2 evidence snapshot");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
