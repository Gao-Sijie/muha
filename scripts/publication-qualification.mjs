export function assertPiPublicationQualification(qualification) {
  const latest = qualification.requalifications?.filter(item => item.harness === "pi").at(-1);
  if (latest?.sdkVersion !== "1.0.4" || latest.status !== "PASS") {
    throw new Error("Latest Pi runtime requalification must pass before publication");
  }
}
