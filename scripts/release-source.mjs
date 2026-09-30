import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";

// Untracked scratch evidence is not an input to the build. Any tracked change
// (including documentation), or any other untracked file, disqualifies a
// candidate. A source archive without Git can produce previews only.
export async function readReleaseSource(root) {
  const git = args => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || await realpath(top.stdout.trim()) !== await realpath(root)) {
    return { revision: null, tree: null, dirty: true };
  }
  const revision = git(["rev-parse", "--verify", "HEAD"]);
  const tree = git(["rev-parse", "--verify", "HEAD^{tree}"]);
  if (revision.status !== 0 || tree.status !== 0) return { revision: null, tree: null, dirty: true };
  const changes = git(["diff", "--quiet", "HEAD", "--"]);
  if (changes.error || ![0, 1].includes(changes.status)) throw new Error("Cannot inspect release source changes");
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked.status !== 0) throw new Error("Cannot inspect untracked release source");
  return { revision: revision.stdout.trim(), tree: tree.stdout.trim(),
    dirty: changes.status !== 0 || untracked.stdout.split("\0").some(path => path && !path.startsWith(".scratch/")) };
}
