import readline from 'node:readline/promises'

export function canPrompt(io = {}) {
  return Boolean(io.prompt || io.stdin?.isTTY || (!io.stdin && process.stdin.isTTY))
}

export function createPrompt(io = {}) {
  if (io.prompt) return io.prompt
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

export async function ask(prompt, { message, defaultValue = '', validate = () => '' }) {
  while (true) {
    const suffix = defaultValue ? ` [${defaultValue}]` : ''
    const raw = await prompt.ask(`? ${message}${suffix}: `)
    const value = String(raw || defaultValue).trim()
    const error = validate(value)
    if (!error) return value
    if (prompt.write) prompt.write(`Invalid value: ${error}`)
    else console.error(`Invalid value: ${error}`)
  }
}

export async function choose(prompt, { message, choices, defaultValue }) {
  const labels = choices.map((choice, index) => formatChoice(choice, index)).join('\n')
  const defaultIndex = Math.max(0, choices.findIndex((choice) => choice.value === defaultValue))
  while (true) {
    const raw = await prompt.ask(`? ${message}\n${labels}\nChoose [${defaultIndex + 1}]: `)
    const value = String(raw || String(defaultIndex + 1)).trim()
    const byNumber = choices[Number.parseInt(value, 10) - 1]
    if (byNumber) return byNumber.value
    const byValue = choices.find((choice) => choice.value === value || choice.label === value)
    if (byValue) return byValue.value
    if (prompt.write) prompt.write(`Invalid choice: ${value}`)
    else console.error(`Invalid choice: ${value}`)
  }
}

export async function confirm(prompt, { message, defaultValue = false }) {
  const hint = defaultValue ? 'Y/n' : 'y/N'
  const raw = await prompt.ask(`? ${message} [${hint}]: `)
  const value = String(raw || (defaultValue ? 'y' : 'n')).trim().toLowerCase()
  return ['y', 'yes', 'true', '1'].includes(value)
}

function formatChoice(choice, index) {
  const description = choice.description ? `\n   ${choice.description}` : ''
  return `${index + 1}. ${choice.label}${description}`
}
