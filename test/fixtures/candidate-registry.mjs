import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// A pre-publication npm boundary serving only the exact prepared Muha tarballs.
// Third-party package requests go to the anonymous public Registry unchanged.
const directory = process.argv[2];
const release = JSON.parse(await readFile(join(directory, "release.json"), "utf8"));
const packages = new Map(), archives = new Map();
for (const item of release.packages) {
  if (!/^[a-z0-9.-]+\.tgz$/.test(item.filename)) throw new Error("Invalid candidate filename");
  const archive = join(directory, item.filename), bytes = await readFile(archive);
  if (createHash("sha256").update(bytes).digest("hex") !== item.sha256 ||
      `sha512-${createHash("sha512").update(bytes).digest("base64")}` !== item.integrity) {
    throw new Error("Candidate Registry refuses changed archive bytes");
  }
  const packed = spawnSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" });
  if (packed.status !== 0) throw new Error("Cannot read candidate package metadata");
  const manifest = JSON.parse(packed.stdout);
  if (manifest.name !== item.name || manifest.version !== item.version) throw new Error("Changed candidate identity");
  packages.set(manifest.name, { item, manifest });
  archives.set(`/tar/${item.filename}`, bytes);
}

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1"), path = decodeURIComponent(url.pathname);
  if (request.method !== "GET") { response.writeHead(405).end(); return; }
  if (archives.has(path)) { response.writeHead(200).end(archives.get(path)); return; }
  for (const [name, { item, manifest }] of packages) {
    const version = { ...manifest, dist: { integrity: item.integrity,
      tarball: `http://127.0.0.1:${server.address().port}/tar/${item.filename}` } };
    if (path === `/${name}` || path === `/${name}/${item.version}`) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(path === `/${name}`
        ? { name, "dist-tags": { latest: item.version }, versions: { [item.version]: version } }
        : version));
      return;
    }
  }
  if (path.startsWith("/@muha-sdk/") || path.startsWith("/muha/")) {
    response.writeHead(404).end(); return;
  }
  response.writeHead(302, { Location: new URL(request.url, "https://registry.npmjs.org/").href }).end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
process.stdout.write(`http://127.0.0.1:${server.address().port}/\n`);
process.on("SIGTERM", () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
