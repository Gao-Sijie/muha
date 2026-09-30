export function parseJobs(source) {
  return source.trim().split("\n").map((line) => {
    const [id, durationSource, dependenciesSource = ""] = line.split("|");
    return {
      id,
      duration: durationSource,
      dependencies: dependenciesSource.split(","),
    };
  });
}
