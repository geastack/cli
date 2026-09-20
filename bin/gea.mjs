#!/usr/bin/env node
import { runGea } from '../src/gea.mjs'
import pc from 'picocolors'

import { CliError } from '../src/errors.mjs'

try {
  const exitCode = await runGea(process.argv.slice(2))
  if (exitCode) process.exit(exitCode)
} catch (error) {
  if (error instanceof CliError) {
    console.error(pc.red(error.message))
    process.exit(error.exitCode)
  }
  console.error(error && error.stack ? error.stack : String(error))
  process.exit(1)
}
