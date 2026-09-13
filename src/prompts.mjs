import readline from 'node:readline/promises'

import * as clack from '@clack/prompts'
import pc from 'picocolors'

import { CliError, ExitCode } from './errors.mjs'

// Three prompt backends share one interface: clack on a real terminal, plain
// readline on a piped stdin, and whatever the caller injects as `io.prompt`
// (the tests script answers that way). The helpers below pick by capability,
// so command code never knows which one it got.

export function canPrompt(io = {}) {
  return Boolean(io.prompt || io.stdin?.isTTY || (!io.stdin && process.stdin.isTTY))
}

export function createPrompt(io = {}) {
  if (io.prompt) return io.prompt
  if (onTerminal(io)) return clackPrompt()

  return readlinePrompt(io)
}

// clack draws on the process terminal only; a caller that injects streams or
// answers gets plain text so its output stays capturable.
function onTerminal(io) {
  const input = io.stdin || process.stdin
  const output = io.output || process.stdout
  return !io.prompt && input === process.stdin && output === process.stdout && Boolean(input.isTTY)
}

export async function ask(prompt, { message, defaultValue = '', validate = () => '' }) {
  if (prompt.text) return prompt.text({ message, defaultValue, validate })

  while (true) {
    const suffix = defaultValue ? ` [${defaultValue}]` : ''
    const raw = await prompt.ask(`? ${message}${suffix}: `)
    const value = String(raw || defaultValue).trim()
    const error = validate(value)
    if (!error) return value

    write(prompt, `Invalid value: ${error}`)
  }
}

export async function choose(prompt, { message, choices, defaultValue }) {
  if (prompt.select) return prompt.select({ message, choices, defaultValue })

  const labels = choices.map((choice, index) => formatChoice(choice, index)).join('\n')
  const defaultIndex = Math.max(0, choices.findIndex((choice) => choice.value === defaultValue))
  while (true) {
    const raw = await prompt.ask(`? ${message}\n${labels}\nChoose [${defaultIndex + 1}]: `)
    const value = String(raw || String(defaultIndex + 1)).trim()
    const byNumber = choices[Number.parseInt(value, 10) - 1]
    if (byNumber) return byNumber.value

    const byValue = choices.find((choice) => choice.value === value || choice.label === value)
    if (byValue) return byValue.value

    write(prompt, `Invalid choice: ${value}`)
  }
}

export async function confirm(prompt, { message, defaultValue = false }) {
  if (prompt.confirm) return prompt.confirm({ message, defaultValue })

  const hint = defaultValue ? 'Y/n' : 'y/N'
  const raw = await prompt.ask(`? ${message} [${hint}]: `)
  const value = String(raw || (defaultValue ? 'y' : 'n')).trim().toLowerCase()
  return ['y', 'yes', 'true', '1'].includes(value)
}

// Section output that matches the active prompt style: clack draws its own
// guide rail, everything else gets plain lines.
export function ui(io = {}) {
  const stdout = io.stdout || console.log
  const styled = onTerminal(io)
  return {
    intro(title, lines = []) {
      if (!styled) {
        stdout(title)
        stdout('-'.repeat(title.length))
        for (const line of lines) stdout(line)
        return
      }

      clack.intro(pc.bold(title))
      for (const line of lines) clack.log.message(pc.dim(line))
    },
    step(title, lines = []) {
      if (!styled) {
        stdout('')
        stdout(`[ ${title} ]`)
        for (const line of lines.filter(Boolean)) stdout(line)
        return
      }

      clack.log.step(pc.bold(title))
      for (const line of lines.filter(Boolean)) clack.log.message(pc.dim(line))
    },
    rows(rows) {
      const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0)
      const lines = rows.map(([label, value]) => `${label.padEnd(width)} : ${value || 'not set'}`)
      if (!styled) {
        for (const line of lines) stdout(line)
        return
      }

      clack.log.message(lines.join('\n'))
    },
    success(line) {
      if (!styled) {
        stdout(line)
        return
      }

      clack.log.success(line)
    },
    outro(line) {
      if (!styled) {
        stdout(line)
        return
      }

      clack.outro(line)
    }
  }
}

function clackPrompt() {
  return {
    async text({ message, defaultValue, validate }) {
      const value = await clack.text({
        message,
        placeholder: defaultValue || undefined,
        defaultValue,
        validate: (raw) => validate(String(raw || defaultValue).trim()) || undefined
      })
      return String(unwrap(value) ?? defaultValue).trim()
    },
    async select({ message, choices, defaultValue }) {
      const value = await clack.select({
        message,
        options: choices.map((choice) => ({ value: choice.value, label: choice.label, hint: choice.description })),
        initialValue: defaultValue
      })
      return unwrap(value)
    },
    async confirm({ message, defaultValue }) {
      return unwrap(await clack.confirm({ message, initialValue: defaultValue }))
    },
    async close() {}
  }
}

function readlinePrompt(io) {
  const rl = readline.createInterface({
    input: io.stdin || process.stdin,
    output: io.output || process.stdout
  })
  return {
    async ask(question) {
      return rl.question(question)
    },
    async close() {
      rl.close()
    }
  }
}

function unwrap(value) {
  if (!clack.isCancel(value)) return value

  clack.cancel('Cancelled.')
  throw new CliError('Cancelled.', ExitCode.usage)
}

function write(prompt, line) {
  if (prompt.write) prompt.write(line)
  else console.error(line)
}

function formatChoice(choice, index) {
  const description = choice.description ? `\n   ${choice.description}` : ''
  return `${index + 1}. ${choice.label}${description}`
}
