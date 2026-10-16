import { createConnection } from "node:net";
import { once } from "node:events";

export async function createWorkerTransport() {
  if (process.platform !== "win32") return {
    send: message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve())),
    onMessage: callback => process.on("message", callback),
    disconnect: () => process.disconnect(),
  };
  const path = process.env.MUHA_INTERNAL_PI_PIPE;
  if (!path?.startsWith("\\\\.\\pipe\\muha-")) throw new Error("Missing owned Pi worker transport");
  const socket = createConnection(path);
  const pending = [];
  let callback, buffer = "";
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  socket.setEncoding("utf8");
  socket.on("error", rejectReady);
  socket.once("close", () => rejectReady(new Error("Pi owner closed before transport setup")));
  socket.on("data", data => {
    buffer += data;
    if (Buffer.byteLength(buffer) > 64 * 1024 * 1024) { socket.destroy(new Error("Pi transport frame exceeds its bound")); return; }
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let value;
      try { value = JSON.parse(line); } catch { socket.destroy(new Error("Invalid owned Pi transport frame")); return; }
      if (value?.type === "transport.ready") resolveReady();
      else if (callback) callback(value);
      else if (pending.length < 64) pending.push(value);
      else { socket.destroy(new Error("Pi transport setup queue exceeded its bound")); return; }
    }
  });
  await ready;
  return {
    send: message => new Promise((resolve, reject) => {
      if (socket.destroyed) { reject(new Error("Pi transport is disconnected")); return; }
      socket.write(JSON.stringify(message) + "\n", error => error ? reject(error) : resolve());
    }),
    onMessage(handler) { callback = handler; for (const value of pending.splice(0)) handler(value); },
    disconnect() { socket.end(() => socket.destroy()); },
  };
}
