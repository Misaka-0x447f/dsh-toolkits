import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function readPrivateToken(filePath) {
  if (!path.isAbsolute(filePath || '')) {
    throw new Error('fixedLaunchTokenFile must be an absolute path')
  }
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > 128) {
      throw new Error('fixedLaunchTokenFile must be a private, current-user-owned regular file of at most 128 bytes')
    }
    const token = (await file.readFile('utf8')).trim()
    if (!UUID_V4.test(token)) {
      throw new Error('fixedLaunchTokenFile must contain one UUIDv4 token')
    }
    return token
  } finally {
    await file.close()
  }
}

export async function overrideLaunchToken(connection, filePath) {
  const auth = connection?.browserAuth
  if (!auth || typeof auth.launchToken !== 'string' || typeof connection.authenticatedUrl !== 'function') {
    throw new Error('DSH connection browser authentication interface is unavailable')
  }
  const token = await readPrivateToken(filePath)
  const previous = auth.launchToken
  auth.launchToken = token
  try {
    const url = new URL(connection.authenticatedUrl('http://127.0.0.1/'))
    if (url.searchParams.get('token') !== token) {
      throw new Error('DSH connection did not accept the fixed launch token')
    }
  } catch (error) {
    auth.launchToken = previous
    throw error
  }
  return () => {
    if (auth.launchToken === token) auth.launchToken = previous
  }
}
