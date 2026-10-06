import assert from 'node:assert/strict';

export const clipboardPackageNames = [
  '', '-darwin-arm64', '-darwin-universal', '-darwin-x64',
  '-linux-arm64-gnu', '-linux-arm64-musl', '-linux-riscv64-gnu',
  '-linux-x64-gnu', '-linux-x64-musl', '-win32-arm64-msvc', '-win32-x64-msvc',
].map(suffix => `@mariozechner/clipboard${suffix}`);

// Audit installed bytes plus every explicitly absent optional edge. npm versions
// legitimately differ in whether foreign-platform optional binaries are installed.
export function assertClipboardLicenseEvidence({ nodes, edges, upstreamLicenseGaps, licenseBlockers }) {
  const clipboard = nodes.filter(node => node.name.startsWith('@mariozechner/clipboard'));
  const parent = clipboard.find(node => node.name === '@mariozechner/clipboard');
  assert.ok(parent, 'ordinary Pi dependency must expose the pinned clipboard identity');
  const variants = edges.filter(edge => edge.from === parent.path && edge.name.startsWith('@mariozechner/clipboard-'));
  assert.deepEqual(variants.map(edge => edge.name).sort(), clipboardPackageNames.slice(1).sort());
  for (const edge of variants) {
    assert.equal(edge.optional, true);
    assert.ok(['present', 'absent'].includes(edge.status));
    assert.equal(clipboard.some(node => node.path === edge.path), edge.status === 'present');
  }
  for (const node of clipboard) {
    assert.ok(clipboardPackageNames.includes(node.name));
    assert.equal(node.version, '0.3.9');
    assert.equal(node.licenseEvidence?.status, 'blocked', node.name);
    assert.ok(upstreamLicenseGaps.some(gap => gap.startsWith(`${node.name}@${node.version}:`)), node.name);
  }
  assert.equal(upstreamLicenseGaps.filter(gap => gap.startsWith('@mariozechner/clipboard')).length, clipboard.length);
  assert.deepEqual(licenseBlockers, [], 'unbundled dependencies must not become Muha redistribution');
}
