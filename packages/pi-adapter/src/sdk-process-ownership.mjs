import { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";

// Installed only inside the owned worker, before loading Pi or extensions.
// Observe Node's process-creation boundary without changing spawn options,
// native tools, extension loading, or the SDK source patch.
const nativeSpawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function (options) {
  const result = Reflect.apply(nativeSpawn, this, [options]);
  if (options.detached && this.pid) {
    try {
      const stat = readFileSync(`/proc/${this.pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      process.send({ type: "owned-process", pid: this.pid, startTime: fields[19] });
    } catch (error) {
      // A short-lived child can exit before its identity is observed.
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
    }
  }
  return result;
};
