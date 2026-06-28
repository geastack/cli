#!/usr/bin/env node
import { runCreateGeastack } from '../src/create-geastack.mjs'
import { CliError } from '../src/errors.mjs'

try {
  const exitCode = await runCreateGeastack(process.argv.slice(2))
  if (exitCode) process.exit(exitCode)
} catch (error) {
  if (error instanceof CliError) {
    console.error(error.message)
    process.exit(error.exitCode)
  }
  console.error(error && error.stack ? error.stack : String(error))
  process.exit(1)
}
