// Resolve a production dependency manifest inside the repository from any
// consuming package directory, honoring npm's hoisted layout and nested
// node_modules. Returns the absolute package.json path, or undefined.
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function walk(fromDirectory, name) {
  let current = fromDirectory;
  for (;;) {
    const candidate = join(current, "node_modules", name, "package.json");
    if (await exists(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}