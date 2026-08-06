export function shouldLoadRootEnvironment(environment) {
  return environment.NODE_ENV === undefined || environment.NODE_ENV === 'development';
}

export function createDrizzleArguments({
  environment,
  environmentFile,
  drizzleKit,
  commandArguments,
}) {
  const environmentArguments = shouldLoadRootEnvironment(environment)
    ? [`--env-file-if-exists=${environmentFile}`]
    : [];

  return [...environmentArguments, drizzleKit, ...commandArguments];
}
