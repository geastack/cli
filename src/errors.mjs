export const ExitCode = Object.freeze({
  generic: 1,
  usage: 2,
  missingDependency: 3,
  targetUnavailable: 4,
  buildFailed: 5,
  deployFailed: 6
})

export class CliError extends Error {
  constructor(message, exitCode = ExitCode.generic) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

export function fail(message, exitCode = ExitCode.generic) {
  throw new CliError(`ERROR: ${message}`, exitCode)
}
