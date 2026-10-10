import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { verifyInstallMetadata, verifyLatest, verifyPublishedPackage } from "../../scripts/registry-readback.mjs";

const bytes = Buffer.from("reviewed archive fixture"), revision = "a".repeat(40);
const item = { name: "@muha-sdk/muha", version: "0.1.15", sha256: createHash("sha256").update(bytes).digest("hex"),
  integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
const metadata = () => ({ name: item.name, version: item.version, dist: { integrity: item.integrity,
  tarball: "https://registry.npmjs.org/@muha-sdk/muha/-/muha-0.1.15.tgz",
  attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/@muha-sdk%2fmuha@0.1.15", provenance: {} } } });
const proof = (source = revision) => ({ attestations: [{ predicateType: "https://slsa.dev/provenance/v1",
  bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify({
    _type: "https://in-toto.io/Statement/v1", predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: `pkg:npm/%40muha-sdk/muha@${item.version}`, digest: { sha512: Buffer.from(item.integrity.slice(7), "base64").toString("hex") } }],
    predicate: { buildDefinition: {
      externalParameters: { workflow: { repository: "https://github.com/Gao-Sijie/muha", path: ".github/workflows/sdk-release.yml", ref: "refs/heads/main" } },
      resolvedDependencies: [{ uri: "git+https://github.com/Gao-Sijie/muha@refs/heads/main", digest: { gitCommit: source } }],
    }, runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } } },
  })).toString("base64") } } }] });
const json = value => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
function readback({ version, artifact = bytes, provenance = proof() } = {}) {
  return async (url, options) => {
    assert.equal(options.method, undefined, "Readback must never issue a write");
    if (url.pathname.endsWith(".tgz")) return new Response(artifact);
    if (url.pathname.includes("attestations")) return json(provenance);
    return version ? version() : json(metadata());
  };
}

test("new package readback waits for version/provenance propagation without retrying upload", async () => {
  let attempts = 0, waits = 0;
  const result = await verifyPublishedPackage(item, revision, {
    fetcher: readback({ version() {
      attempts++;
      if (attempts === 1) return new Response(null, { status: 404 });
      if (attempts === 2) { const pending = metadata(); delete pending.dist.attestations; return json(pending); }
      return json(metadata());
    } }), sleep: async () => { waits++; },
  });
  assert.equal(result.status, "READBACK_PASS");
  assert.equal(attempts, 3);
  assert.equal(waits, 2);
});

test("wrong identity, integrity, artifact, source or origin immediately stops publication", async () => {
  const changedName = metadata(); changedName.name = "another-package";
  const changedIntegrity = metadata(); changedIntegrity.dist.integrity = "sha512-changed";
  const changedOrigin = metadata(); changedOrigin.dist.tarball = "https://example.com/tarball.tgz";
  for (const fetcher of [
    readback({ version: () => json(changedName) }), readback({ version: () => json(changedIntegrity) }),
    readback({ artifact: Buffer.from("substituted bytes") }), readback({ provenance: proof("b".repeat(40)) }),
    readback({ version: () => json(changedOrigin) }),
    readback({ version: () => new Response(null, { status: 401 }) }),
  ]) {
    let waits = 0;
    await assert.rejects(verifyPublishedPackage(item, revision, { fetcher, sleep: async () => { waits++; } }));
    assert.equal(waits, 0, "Invalid evidence is not Registry propagation");
  }
});

test("missing Registry evidence has a finite attempt and elapsed-time budget", async () => {
  let attempts = 0, waits = 0;
  await assert.rejects(verifyPublishedPackage(item, revision, {
    fetcher: async () => { attempts++; return new Response(null, { status: 404 }); },
    sleep: async () => { waits++; }, attempts: 3,
  }), /404/);
  assert.equal(attempts, 3); assert.equal(waits, 2);
  let time = 0;
  attempts = 0;
  await assert.rejects(verifyPublishedPackage(item, revision, {
    fetcher: async () => { attempts++; return new Response(null, { status: 503 }); },
    now: () => time, sleep: async () => { time = 300000; },
  }), /503/);
  assert.equal(attempts, 2);
});

test("both npm install metadata formats must expose the reviewed exact version", async () => {
  const formats = [], seen = new Map();
  await verifyInstallMetadata(item, { fetcher: async (_url, options) => {
    const format = options.headers.Accept;
    formats.push(format);
    if (!seen.has(format)) { seen.set(format, true); return json({ versions: {} }); }
    return json({ versions: { [item.version]: metadata() } });
  }, sleep: async () => {} });
  assert.deepEqual(formats, ["application/json", "application/json", "application/vnd.npm.install-v1+json", "application/vnd.npm.install-v1+json"]);
  const wrong = metadata(); wrong.dist.integrity = "sha512-changed";
  await assert.rejects(verifyInstallMetadata(item, {
    fetcher: async () => json({ versions: { [item.version]: wrong } }),
    sleep: async () => assert.fail("Mismatched install metadata cannot retry"),
  }), /identity\/integrity/);
});

test("latest readback waits for the promoted tag to become visible", async () => {
  let attempts = 0;
  await verifyLatest(item, { fetcher: async () => json({ "dist-tags": { latest: ++attempts === 1 ? "0.1.13" : item.version } }),
    sleep: async () => {}, attempts: 2 });
  assert.equal(attempts, 2);
});
