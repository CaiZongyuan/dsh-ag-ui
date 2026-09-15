import { ToolCallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

/**
 * Stateless content-keyed scripted model for the durable fixture: every
 * response depends only on the request text, so behavior is identical before
 * and after a process restart.
 */

function text(value) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCall(id, name, args) {
  const encoded = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: encoded },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: encoded } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function latestUserText(request) {
  for (const message of [...request.messages].reverse()) {
    if (message.role === 'user' && message.source?.kind === 'user' && message.content[0]?.type === 'text') {
      return message.content[0].text
    }
  }
  return ''
}

class DurableScriptedAdapter extends LlmAdapter {
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(request) {
    const serialized = JSON.stringify(request.messages)
    const prompt = latestUserText(request)
    if (prompt.startsWith('Set the codeword')) {
      yield* text('The codeword is pine-cone-7.')
    } else if (prompt.startsWith('Repeat the codeword') && serialized.includes('pine-cone-7')) {
      yield* text('History kept the codeword pine-cone-7.')
    } else if (prompt.startsWith('Ask the human')) {
      yield* toolCall('fixture-question', 'ask_user_question', { questions: [{ id: 'confirm', question: 'Confirm?' }] })
    } else if (prompt.startsWith('Draft the note')) {
      yield* toolCall('fixture-draft-note', 'ui_draft_note', { subject: 'durable-note' })
    } else if (serialized.includes('signed-off')) {
      yield* text('The durable note is complete.')
    } else if (prompt.startsWith('Ping')) {
      yield* text('pong.')
    } else {
      yield* text('The durable fixture did not understand that prompt.')
    }
  }
}

export const name = 'durable-scripted-model'
export const inject = ['llm']

export function apply(ctx) {
  ctx.llm.registerAdapter(['fixture-scripted'], new DurableScriptedAdapter())
}
