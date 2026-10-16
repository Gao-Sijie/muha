import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Malformed-frame injection belongs to the fixture. On Windows the SDK has an
// owned pipe, so wire this fixture's process.send to that actual connection.
// Product code retains its explicit transport and never installs this shim.
export async function enableFixtureIpc(fixture) {
  if (process.platform !== 'win32') return;
  const preload = join(fixture.root, 'fixture-ipc.mjs');
  await writeFile(preload, `
    import net from 'node:net';
    import { syncBuiltinESMExports } from 'node:module';
    const createConnection = net.createConnection;
    net.createConnection = function (...args) {
      const socket = Reflect.apply(createConnection, this, args);
      if (args[0] === process.env.MUHA_INTERNAL_PI_PIPE) {
        process.send = message => socket.write(JSON.stringify(message) + '\\n');
      }
      return socket;
    };
    syncBuiltinESMExports();
  `);
  fixture.options.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
}
