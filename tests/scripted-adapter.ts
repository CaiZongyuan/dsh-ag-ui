import { CallId, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** One deterministic model outcome used by Gateway and Thread tests. */
export type ScriptedResponse = StreamChunk[] | Error

/** Model adapter that records requests and consumes deterministic outcomes in order. */
export class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ScriptedResponse[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const response = this.script.shift()
    if (response instanceof Error) throw response
    if (response === undefined) throw new Error('scripted model adapter exhausted')
    for (const chunk of response) yield chunk
  }
}

/** Create one complete scripted assistant text response. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Create one complete scripted assistant Tool call response. */
export function toolResponse(callId: string, name: string, args: object): StreamChunk[] {
  const encoded = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: CallId(callId), name, argumentsDelta: encoded },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: CallId(callId), name, arguments: encoded },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}
