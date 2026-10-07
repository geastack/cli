// The toolchain search patterns put `*` in a middle segment
// (~/Tools/arm-gnu-toolchain-*/extract/Payload). The first implementation took
// path.dirname of the whole pattern as the directory to list, which still
// contained the `*`, so readdirSync threw and no toolchain was ever found.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { globDirs } from '../src/rp2350/adapter.mjs'

test('globDirs expands a wildcard in a middle segment', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gea-glob-'))
  try {
    mkdirSync(path.join(root, 'arm-gnu-toolchain-14.2', 'extract', 'Payload'), { recursive: true })
    mkdirSync(path.join(root, 'arm-gnu-toolchain-15.2', 'extract', 'Payload'), { recursive: true })
    mkdirSync(path.join(root, 'arm-gnu-toolchain-16.0', 'extract'), { recursive: true })
    mkdirSync(path.join(root, 'other-15.2', 'extract', 'Payload'), { recursive: true })
    assert.deepEqual(globDirs(path.join(root, 'arm-gnu-toolchain-*', 'extract', 'Payload')), [
      path.join(root, 'arm-gnu-toolchain-14.2', 'extract', 'Payload'),
      path.join(root, 'arm-gnu-toolchain-15.2', 'extract', 'Payload')
    ])
    assert.deepEqual(globDirs(path.join(root, 'arm-*')), [
      path.join(root, 'arm-gnu-toolchain-14.2'),
      path.join(root, 'arm-gnu-toolchain-15.2'),
      path.join(root, 'arm-gnu-toolchain-16.0')
    ])
    assert.deepEqual(globDirs(path.join(root, 'missing-*', 'x')), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
