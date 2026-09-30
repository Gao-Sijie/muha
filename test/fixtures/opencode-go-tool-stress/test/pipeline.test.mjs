import assert from "node:assert/strict";
import test from "node:test";

import { parseJobs } from "../src/parse-jobs.mjs";
import { renderReport } from "../src/report.mjs";
import { scheduleJobs } from "../src/scheduler.mjs";

test("parseJobs trims fields, numbers durations, and omits empty dependencies", () => {
  assert.deepEqual(parseJobs(" build | 3 |\ntest|2|build\nship|1|build,test\n"), [
    { id: "build", duration: 3, dependencies: [] },
    { id: "test", duration: 2, dependencies: ["build"] },
    { id: "ship", duration: 1, dependencies: ["build", "test"] },
  ]);
});

test("parseJobs rejects duplicate IDs and invalid durations", () => {
  assert.throws(() => parseJobs("build|1|\nbuild|2|"), /duplicate job: build/);
  assert.throws(() => parseJobs("build|zero|"), /invalid duration for build/);
});

test("scheduleJobs honors dependencies and bounded parallelism", () => {
  const jobs = parseJobs("build|3|\nlint|2|\ntest|2|build\nship|1|build,lint,test");
  assert.deepEqual(scheduleJobs(jobs, 2), [
    { id: "build", startedAt: 0, finishedAt: 3 },
    { id: "lint", startedAt: 0, finishedAt: 2 },
    { id: "test", startedAt: 3, finishedAt: 5 },
    { id: "ship", startedAt: 5, finishedAt: 6 },
  ]);
});

test("scheduleJobs rejects cycles, missing dependencies, and invalid worker counts", () => {
  assert.throws(() => scheduleJobs(parseJobs("a|1|b\nb|1|a"), 2), /dependency cycle/);
  assert.throws(() => scheduleJobs(parseJobs("a|1|missing"), 2), /unknown dependency: missing/);
  assert.throws(() => scheduleJobs(parseJobs("a|1|"), 0), /worker count/);
});

test("renderReport uses elapsed duration and preserves its input", () => {
  const entries = [
    { id: "build", startedAt: 0, finishedAt: 3 },
    { id: "lint", startedAt: 0, finishedAt: 2 },
    { id: "ship", startedAt: 3, finishedAt: 4 },
  ];
  assert.equal(renderReport(entries), "jobs=3\nduration=4\ncritical=ship");
  assert.deepEqual(entries.map(({ id }) => id), ["build", "lint", "ship"]);
});

test("renderReport handles an empty schedule", () => {
  assert.equal(renderReport([]), "jobs=0\nduration=0\ncritical=none");
});
