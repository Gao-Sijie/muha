import assert from 'node:assert/strict';
import test from 'node:test';
import { assertClipboardLicenseEvidence, clipboardPackageNames } from '../support/clipboard-license-contract.mjs';

function evidence(installed) {
  const nodes = installed.map(name => ({ name, version: '0.3.9', path: `node_modules/${name}`,
    licenseEvidence: { status: 'blocked' } }));
  return { nodes, edges: clipboardPackageNames.slice(1).map(name => ({
    from: 'node_modules/@mariozechner/clipboard', name, optional: true,
    status: installed.includes(name) ? 'present' : 'absent', path: `node_modules/${name}`,
  })), upstreamLicenseGaps: installed.map(name => `${name}@0.3.9: unverified`), licenseBlockers: [] };
}

test('clipboard audit retains all eleven identities even when npm omits foreign optional binaries', () => {
  const installed = clipboardPackageNames.filter(name => name === '@mariozechner/clipboard' || name.includes('linux-x64'));
  assert.equal(installed.length, 3);
  assertClipboardLicenseEvidence(evidence(installed));
  assertClipboardLicenseEvidence(evidence(clipboardPackageNames));
});

test('clipboard audit rejects a missing inventory edge or hidden installed license gap', () => {
  const omitted = evidence(clipboardPackageNames);
  omitted.edges.pop();
  assert.throws(() => assertClipboardLicenseEvidence(omitted));
  const hidden = evidence(clipboardPackageNames);
  hidden.upstreamLicenseGaps.pop();
  assert.throws(() => assertClipboardLicenseEvidence(hidden));
});
