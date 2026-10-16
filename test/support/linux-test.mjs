import test from 'node:test';

// The retained Codex combined bridge and Unix observer are historical Linux
// evidence. The official Windows Registration uses native app-server and its
// common text, rich-Turn, lifecycle and permission contracts still run there.
export function linuxTest(name, options, body) {
  if (typeof options === 'function') { body = options; options = {}; }
  return test(name, { ...options, ...(process.platform === 'win32'
    ? { skip: 'Historical Linux Codex combined bridge / Unix observer qualification' } : {}) }, body);
}
