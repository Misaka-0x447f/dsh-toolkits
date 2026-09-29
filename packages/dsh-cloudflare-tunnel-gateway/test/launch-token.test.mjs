import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { overrideLaunchToken } from '../lib/launch-token.js'

const testToken = '32fa5f3d-e746-481e-b4fb-8daa8650ec3b'

test('fixed token replaces DSH launch token and restores it on cleanup', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-token-test-'))
  const file = path.join(dir, 'token')
  try {
    await writeFile(file, `${testToken}\n`, { mode: 0o600 })
    const browserAuth = { launchToken: 'previous-token' }
    const connection = {
      browserAuth,
      authenticatedUrl(base) {
        return `${base}?token=${this.browserAuth.launchToken}`
      },
    }
    const restore = await overrideLaunchToken(connection, file)
    assert.equal(new URL(connection.authenticatedUrl('http://127.0.0.1/')).searchParams.get('token'), testToken)
    restore()
    assert.equal(browserAuth.launchToken, 'previous-token')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('fixed token rejects a readable-by-others file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-token-test-'))
  const file = path.join(dir, 'token')
  try {
    await writeFile(file, testToken, { mode: 0o600 })
    await chmod(file, 0o644)
    const connection = {
      browserAuth: { launchToken: 'previous-token' },
      authenticatedUrl: () => 'http://127.0.0.1/?token=previous-token',
    }
    await assert.rejects(overrideLaunchToken(connection, file), /private/)
    assert.equal(connection.browserAuth.launchToken, 'previous-token')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
