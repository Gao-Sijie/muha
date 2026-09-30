export function scheduleJobs(jobs, workerCount) {
  if (workerCount < 1) throw new Error("invalid concurrency");
  const completed = new Set();
  const scheduled = [];
  let time = 0;

  while (scheduled.length < jobs.length) {
    const ready = jobs.filter((job) =>
      !completed.has(job.id) && job.dependencies.every((id) => completed.has(id)));
    if (ready.length === 0) throw new Error("scheduler stalled");
    for (const job of ready.slice(0, workerCount)) {
      scheduled.push({ id: job.id, startedAt: time, finishedAt: time + job.duration });
      completed.add(job.id);
    }
    time += 1;
  }
  return scheduled;
}
