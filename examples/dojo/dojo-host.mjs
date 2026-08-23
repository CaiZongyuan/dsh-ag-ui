import { once } from 'node:events'
import { DOJO_FEATURES, DOJO_SHARED_SECRET, DOJO_TENANT_ID, FEATURE_CONTEXT_NAME, FEATURE_INSTRUCTIONS, INITIAL_RECIPE_STATE, WEATHER_RESULT } from './scenarios.mjs'
import { resetScenarioState, scenarioSnapshot } from './scenario-state.mjs'

const MAX_BODY_BYTES = 1024 * 1024

export const name = 'dojo-host'
export const inject = ['webServer', 'tools', 'agUi']

export function apply(ctx, config = {}) {
  resetScenarioState()

  ctx.effect(() => {
    const disposers = []
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/health',
      handler: (request, response) => handleHealth(request, response),
    }))
    for (const feature of DOJO_FEATURES) {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: `/${feature}`,
        handler: (request, response) => handleFeature(ctx, feature, request, response),
      }))
    }
    if (config.debug === true) {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: '/debug/state',
        handler: (request, response) => handleDebug(request, response),
      }))
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: '/debug/shutdown',
        handler: (request, response) => handleShutdown(ctx, request, response),
      }))
    }
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'dojo.routes')

  ctx.effect(() => ctx.tools.register({
    name: 'get_weather',
    description: 'Read deterministic weather for the requested location.',
    parameters: {
      type: 'object',
      properties: { location: { type: 'string' } },
      required: ['location'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          temperature: { type: 'number' },
          conditions: { type: 'string' },
          humidity: { type: 'number' },
          windSpeed: { type: 'number' },
          feelsLike: { type: 'number' },
        },
        required: ['temperature', 'conditions', 'humidity', 'windSpeed', 'feelsLike'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    presentCall: args => ({ card: 'generic', title: 'Read weather', rawInput: args }),
    execute: async (args, exec) => {
      if (exec.agent === undefined) throw new Error('The Dojo weather Tool requires an Agent caller.')
      const identity = ctx.agUi.identityFor(exec.agent)
      if (identity?.principal.tenantId !== DOJO_TENANT_ID
        || identity.principal.userId !== 'dojo:backend_tool_rendering') {
        throw new Error('The authenticated Dojo feature cannot access the weather Tool.')
      }
      return structuredClone(WEATHER_RESULT)
    },
  }), 'dojo.weatherTool')
}

function handleHealth(request, response) {
  if (request.method !== 'GET') return methodNotAllowed(response, 'GET')
  writeJson(response, 200, { status: 'healthy', agents: DOJO_FEATURES })
}

function handleDebug(request, response) {
  if (request.method !== 'GET') return methodNotAllowed(response, 'GET')
  writeJson(response, 200, scenarioSnapshot())
}

function handleShutdown(ctx, request, response) {
  if (request.method !== 'POST') return methodNotAllowed(response, 'POST')
  writeJson(response, 202, { status: 'shutting-down' })
  setImmediate(() => { void ctx.root.fiber.dispose() })
}

async function handleFeature(ctx, feature, request, response) {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, corsHeaders())
    response.end()
    return
  }
  if (request.method !== 'POST') return methodNotAllowed(response, 'POST, OPTIONS')

  const abortController = new AbortController()
  let completed = false
  const onClose = () => {
    if (!completed) abortController.abort()
  }
  response.once('close', onClose)
  try {
    const body = await readBody(request)
    const input = JSON.parse(body.toString('utf8'))
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('AG-UI input must be a JSON object.')
    }
    if (feature === 'shared_state' && isEmptyObject(input.state)) {
      input.state = structuredClone(INITIAL_RECIPE_STATE)
    }
    const context = Array.isArray(input.context)
      ? input.context.filter(item => item?.description !== FEATURE_CONTEXT_NAME)
      : []
    input.context = [{
      description: FEATURE_CONTEXT_NAME,
      value: `${feature}\n${FEATURE_INSTRUCTIONS[feature]}`,
    }, ...context]
    const upstream = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}/_internal/ag-ui`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${DOJO_SHARED_SECRET}`,
        'content-type': 'application/json',
        'x-dsh-tenant-id': DOJO_TENANT_ID,
        'x-dsh-user-id': `dojo:${feature}`,
      },
      body: JSON.stringify(input),
      signal: abortController.signal,
    })
    response.writeHead(upstream.status, {
      ...corsHeaders(),
      'cache-control': upstream.headers.get('cache-control') ?? 'no-cache, no-transform',
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
    })
    if (upstream.body !== null) {
      for await (const chunk of upstream.body) {
        if (response.destroyed || response.writableEnded) {
          abortController.abort()
          return
        }
        if (!response.write(Buffer.from(chunk))) {
          const drained = await Promise.race([
            once(response, 'drain').then(() => true),
            once(response, 'close').then(() => false),
          ])
          if (!drained) {
            abortController.abort()
            return
          }
        }
      }
    }
    completed = true
    if (!response.destroyed && !response.writableEnded) response.end()
  } catch (error) {
    if (abortController.signal.aborted && (response.destroyed || response.writableEnded)) return
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : new Error(String(error)))
      return
    }
    writeJson(response, 400, {
      code: 'INVALID_DOJO_REQUEST',
      message: error instanceof Error ? error.message : 'The Dojo request failed.',
    })
  } finally {
    response.off('close', onClose)
  }
}

function isEmptyObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 0
}

async function readBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > MAX_BODY_BYTES) throw new Error('The Dojo request body is too large.')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function methodNotAllowed(response, allow) {
  response.setHeader('allow', allow)
  writeJson(response, 405, { code: 'METHOD_NOT_ALLOWED' })
}

function writeJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    ...corsHeaders(),
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(body)
}

function corsHeaders() {
  return {
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-origin': '*',
  }
}
