export function renderReport(entries) {
  const totalDuration = entries.reduce((total, entry) => total + entry.finishedAt, 0);
  const longest = entries.sort((left, right) => left.finishedAt - right.finishedAt).at(-1);
  return [
    `jobs=${entries.length}`,
    `duration=${totalDuration}`,
    `critical=${longest.id}`,
  ].join("\n");
}
