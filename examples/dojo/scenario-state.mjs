const abortedRequests = new Map()

export function resetScenarioState() {
  abortedRequests.clear()
}

export function recordAbortedRequest(feature) {
  abortedRequests.set(feature, (abortedRequests.get(feature) ?? 0) + 1)
}

export function scenarioSnapshot() {
  return {
    abortedRequests: Object.fromEntries(abortedRequests),
  }
}
