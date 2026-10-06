export const name = 'durable-host'
export const inject = ['webServer', 'sessionPersistence']

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/health',
    handler: (request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    },
  }), 'durable.health')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/flush',
    handler: async (request, response) => {
      if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${process.env.DSH_AG_UI_FIXTURE_SECRET}`) {
        response.writeHead(403)
        response.end()
        return
      }
      await ctx.sessionPersistence.flush()
      response.writeHead(204)
      response.end()
    },
  }), 'durable.flush')
}
