import z from '@deepseek-ai/schemastery'

import { overrideLaunchToken } from './launch-token.js'

// Retain the package name so the existing Web profile installation keeps working.
export const name = 'dsh-cloudflare-tunnel-gateway'
export const inject = ['webServer', 'connection']

export const Config = z.object({
  enabled: z.boolean().description('Use a fixed DSH Web launch token.').default(false),
  fixedLaunchTokenFile: z.string().description('Absolute path to a private 0600 file containing a UUIDv4 launch token.').default(''),
})

export async function apply(ctx, config) {
  if (!config?.enabled) return
  if (ctx.webServer.host !== '127.0.0.1') {
    throw new Error('DSH web server must remain bound to 127.0.0.1')
  }
  const restore = await overrideLaunchToken(ctx.connection, config.fixedLaunchTokenFile)
  try {
    ctx.effect(() => restore, 'dsh-cloudflare-tunnel-gateway: fixed launch token')
  } catch (error) {
    restore()
    throw error
  }
}
