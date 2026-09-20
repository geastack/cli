import assert from 'node:assert/strict'
import test from 'node:test'

import { flag, option, optionList, parseArgs } from '../src/args.mjs'

test('parseArgs handles options, positionals, repeats, and passthrough', () => {
  const parsed = parseArgs(['build', 'watch', '--target=web', '--board', 'amoled', '--tag', 'a,b', '--tag=c', '--no-color', '--', '--raw'])

  assert.deepEqual(parsed.positionals, ['build', 'watch'])
  assert.equal(option(parsed, 'target'), 'web')
  assert.equal(option(parsed, 'board'), 'amoled')
  assert.deepEqual(optionList(parsed, 'tag'), ['a', 'b', 'c'])
  assert.equal(flag(parsed, 'color'), false)
  assert.deepEqual(parsed.passthrough, ['--raw'])
})

test('parseArgs maps short help/version flags', () => {
  assert.equal(flag(parseArgs(['-h']), 'help'), true)
  assert.equal(flag(parseArgs(['-v']), 'version'), true)
})

test('option returns the last repeated value', () => {
  const parsed = parseArgs(['dev', '--port=5181', '--port', '6000'])

  assert.equal(option(parsed, 'port'), '6000')
})

test('boolean options do not consume following negative-looking positionals', () => {
  const parsed = parseArgs(['list', '--json', '-weird'])

  assert.deepEqual(parsed.positionals, ['list', '-weird'])
  assert.equal(flag(parsed, 'json'), true)
})
