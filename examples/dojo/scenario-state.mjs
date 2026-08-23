const bffRuns = new Map()
const modelRequests = new Map()
const backendToolCalls = []
const abortedRequests = new Map()

export function resetScenarioState() {
  bffRuns.clear()
  modelRequests.clear()
  backendToolCalls.length = 0
  abortedRequests.clear()
}

export function recordBffRun(feature) {
  bffRuns.set(feature, (bffRuns.get(feature) ?? 0) + 1)
}

export function recordModelRequest(feature) {
  const next = (modelRequests.get(feature) ?? 0) + 1
  modelRequests.set(feature, next)
  return next
}

export function recordAbortedRequest(feature) {
  abortedRequests.set(feature, (abortedRequests.get(feature) ?? 0) + 1)
}

export function recordBackendToolCall(call) {
  backendToolCalls.push(structuredClone(call))
}

export function scenarioSnapshot() {
  return {
    bffRuns: Object.fromEntries(bffRuns),
    modelRequests: Object.fromEntries(modelRequests),
    backendToolCalls: structuredClone(backendToolCalls),
    abortedRequests: Object.fromEntries(abortedRequests),
  }
}
