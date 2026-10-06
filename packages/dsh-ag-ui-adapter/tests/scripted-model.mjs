import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

/**
 * Keyless deterministic model for the adapter's end-to-end specs: a scripted
 * adapter that answers from the latest user text and the serialized history,
 * so a multi-turn run proves session memory inside the spawned micro-host.
 */

class AdapterScriptedModel extends LlmAdapter {
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(request) {
    if (request.messages.some(message => message.content.some(block => block.type === 'text' && block.text === 'Probe tool results.'))) {
      if (request.messages.some(message => message.source.kind === 'tool')) {
        yield * text('Tool probes completed.')
      } else {
        for (const [index, outcome] of ['success', 'error', 'empty'].entries()) {
          const id = ToolCallId(`adapter-${outcome}`)
          const args = JSON.stringify({ outcome })
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id, name: 'adapter_result_probe', argumentsDelta: args }
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name: 'adapter_result_probe', arguments: args } }
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
      return
    }
    const latestUser = readLatestUserText(request.messages)
    if (/what is my name/i.test(latestUser)) {
      const named = JSON.stringify(request.messages).match(/my name is ([A-Za-z]+)/i)
      yield * text(named ? `Your name is ${named[1]}.` : 'You have not told me your name.')
      return
    }
    const introduced = latestUser.match(/my name is ([A-Za-z]+)/i)
    yield * text(introduced ? `Hello ${introduced[1]}.` : 'Hello from the DSH AG-UI adapter.')
  }
}

function readLatestUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    if (text && !text.startsWith('## ')) return text
  }
  return ''
}

function * text(value) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: value }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

export const name = 'dsh-ag-ui-adapter/scripted-model'
export const inject = ['llm', 'tools']

export function apply(ctx) {
  ctx.llm.registerAdapter(['scripted'], new AdapterScriptedModel())
  ctx.effect(() => ctx.tools.register({
    name: 'adapter_result_probe',
    description: 'Return a synthetic successful, failed, or empty tool result.',
    parameters: {
      type: 'object',
      properties: { outcome: { type: 'string', enum: ['success', 'error', 'empty'] } },
      required: ['outcome'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => value === '' ? [] : [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    execute: async ({ outcome }) => {
      if (outcome === 'error') throw new Error('Synthetic probe failure')
      return outcome === 'empty' ? '' : 'Synthetic probe success'
    },
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? 'Probe failed' : 'Probe completed',
      content: result.content,
    }),
  }), 'adapter.result.probe')
}
