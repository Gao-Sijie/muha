# Publish one ESM build

Every `@muha-sdk/*` package contains one ESM JavaScript build with explicit package exports and TypeScript declarations, does not contain a separate CommonJS artifact, and avoids top-level `await` in its public entry graph. Both `import` and, where supported by Node.js 22.20, synchronous `require` resolve to that same ESM artifact and receive package-install contract tests; CommonJS consumers may always use dynamic `import()`, while failure of the synchronous compatibility path does not justify adding a second `.cjs` build without a new compatibility decision.
