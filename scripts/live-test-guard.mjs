/* global process */

const expectedProject = "codra-1b3bb";

export function assertLiveTestGuard(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  if (environment.CODRA_LIVE_TEST !== "1" || environment.CI) {
    throw new Error("Live operations require explicit local opt-in.");
  }
  const projectFlags = argv.reduce(
    (count, value) => count + (value === "--project" ? 1 : 0),
    0,
  );
  const confirmationFlags = argv.reduce(
    (count, value) => count + (value === "--confirm-project" ? 1 : 0),
    0,
  );
  if (projectFlags !== 1 || confirmationFlags !== 1 || argv.length !== 4) {
    throw new Error("Live operations require exactly the two project flags.");
  }
  const projectIndex = argv.indexOf("--project");
  const confirmationIndex = argv.indexOf("--confirm-project");
  const project = argv[projectIndex + 1];
  const confirmation = argv[confirmationIndex + 1];
  if (
    projectIndex % 2 !== 0 ||
    confirmationIndex % 2 !== 0 ||
    !project ||
    !confirmation
  ) {
    throw new Error("Live operations require project values after each flag.");
  }
  if (project !== expectedProject || confirmation !== expectedProject) {
    throw new Error(
      "Live operations require the exact confirmed CODRA project.",
    );
  }
  return { project: expectedProject, readOnly: true };
}
