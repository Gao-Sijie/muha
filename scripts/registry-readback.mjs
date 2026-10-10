import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { validateRegistryProvenance } from "./registry-provenance.mjs";

const registry = new URL("https://registry.npmjs.org/");

class RegistryNotReady extends Error {}

async function request(url, fetcher, accept = "application/json") {
  let response;
  try {
    response = await fetcher(url, {
      headers: { Accept: accept, "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new RegistryNotReady("Registry request has not completed", { cause: error });
  }
  if ([404, 429].includes(response.status) || response.status >= 500) {
    throw new RegistryNotReady(`Registry readback HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(`Registry readback HTTP ${response.status}`);
  return response;
}

export async function publishedMetadata(item, fetcher = fetch) {
  const response = await fetcher(new URL(`${encodeURIComponent(item.name)}/${item.version}`, registry), {
    headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Registry version readback HTTP ${response.status}`);
  return response.json();
}

function assertIdentity(info, item) {
  if (info.name !== item.name || info.version !== item.version || info.dist?.integrity !== item.integrity) {
    throw new Error(`${item.name}: registry identity/integrity does not match the reviewed cohort`);
  }
}

function registryURL(value) {
  const url = new URL(value);
  if (url.origin !== registry.origin) throw new Error("Unexpected Registry artifact/provenance origin");
  return url;
}

async function eventually(operation, {
  fetcher = fetch, sleep = delay, attempts = 60, delayMs = 5000, now = Date.now,
} = {}) {
  const deadline = now() + 300000;
  for (let attempt = 1; ; attempt++) {
    try { return await operation(fetcher); }
    catch (error) {
      if (!(error instanceof RegistryNotReady) || attempt >= attempts || now() >= deadline) throw error;
      await sleep(Math.min(delayMs, Math.max(0, deadline - now())));
    }
  }
}

// Retry only missing/temporarily unavailable public readback. Changed identities,
// bytes or source bindings fail immediately. This helper never uploads anything.
export async function verifyPublishedPackage(item, revision, options) {
  return eventually(async fetcher => {
    const info = await (await request(new URL(`${encodeURIComponent(item.name)}/${item.version}`, registry), fetcher)).json();
    assertIdentity(info, item);
    if (!info.dist.attestations?.url || !info.dist.attestations.provenance) {
      throw new RegistryNotReady(`${item.name}: Registry provenance has not propagated`);
    }
    const artifact = await request(registryURL(info.dist.tarball), fetcher);
    const bytes = Buffer.from(await artifact.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== item.sha256 ||
        `sha512-${createHash("sha512").update(bytes).digest("base64")}` !== item.integrity) {
      throw new Error(`${item.name}: registry bytes differ from reviewed tarball`);
    }
    const proof = await request(registryURL(info.dist.attestations.url), fetcher);
    validateRegistryProvenance(await proof.json(), item, revision);
    return { package: item.name, version: item.version, integrity: item.integrity,
      sha256: item.sha256, provenance: info.dist.attestations.url, status: "READBACK_PASS" };
  }, options);
}

export async function verifyInstallMetadata(item, options) {
  for (const accept of ["application/json", "application/vnd.npm.install-v1+json"]) {
    await eventually(async fetcher => {
      const metadata = await (await request(new URL(encodeURIComponent(item.name), registry), fetcher, accept)).json();
      if (!metadata.versions?.[item.version]) {
        throw new RegistryNotReady(`${item.name}: install metadata has not propagated`);
      }
      assertIdentity(metadata.versions[item.version], item);
    }, options);
  }
}

export async function verifyLatest(item, options) {
  await eventually(async fetcher => {
    const metadata = await (await request(new URL(encodeURIComponent(item.name), registry), fetcher)).json();
    if (metadata["dist-tags"]?.latest !== item.version) {
      throw new RegistryNotReady(`${item.name}: latest tag has not propagated`);
    }
  }, options);
}
