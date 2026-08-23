import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { recordAbortedRequest, recordModelRequest } from './scenario-state.mjs'
import { FEATURE_CONTEXT_NAME } from './scenarios.mjs'

class DojoScriptedAdapter extends LlmAdapter {
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(request) {
    const serialized = JSON.stringify(request.messages)
    const feature = readFeature(request.messages)
    const requestNumber = recordModelRequest(feature)
    const latestUser = readLatestUserText(request.messages)
    if (/wait for disconnect/i.test(latestUser)) {
      await waitForAbort(request.signal)
      recordAbortedRequest(feature)
      return
    }
    const response = responseFor(feature, requestNumber, latestUser, serialized, request.messages)
    for (const chunk of response) yield chunk
  }
}

function responseFor(feature, requestNumber, latestUser, serialized, messages) {
  switch (feature) {
    case 'agentic_chat':
      return text(chatResponse(latestUser, serialized))
    case 'backend_tool_rendering':
      return serialized.includes('temperature') && serialized.includes('sunny')
        ? text('The weather lookup completed successfully.')
        : toolCall(`weather-${requestNumber}`, 'get_weather', { location: 'San Francisco' })
    case 'shared_state':
      return sharedStateResponse(requestNumber, latestUser, serialized, messages)
    case 'human_in_the_loop':
      return serialized.includes('accepted') && serialized.includes('true')
        ? text('The approved task plan is ready.')
        : toolCall(`steps-${requestNumber}`, 'generate_task_steps', {
            steps: [
              { description: 'Start The Planning', status: 'enabled' },
              { description: 'Gather the eggs', status: 'enabled' },
              { description: 'Preheat the oven', status: 'enabled' },
            ],
          })
    case 'tool_based_generative_ui':
      return serialized.includes('Haiku generated!')
        ? text('The haiku card is ready.')
        : toolCall(`haiku-${requestNumber}`, 'generate_haiku', {
            japanese: ['春の風', '静かな月', '花が咲く'],
            english: ['Spring wind', 'A quiet moon', 'Flowers bloom'],
            image: 'mountain',
            gradient: 'linear-gradient(135deg, #dbeafe, #f0fdf4)',
          })
    default:
      throw new Error(`Unknown Dojo feature: ${feature}`)
  }
}

function chatResponse(latestUser, serialized) {
  if (/what is my name/i.test(latestUser)) {
    const match = serialized.match(/my name is ([A-Za-z]+)/i)
    return match ? `Your name is ${match[1]}.` : 'You have not told me your name.'
  }
  const match = latestUser.match(/my name is ([A-Za-z]+)/i)
  return match ? `Hello ${match[1]}.` : 'Hello from the DSH AG-UI Dojo example.'
}

function sharedStateResponse(requestNumber, latestUser, serialized, messages) {
  const state = readSharedState(messages)
  if (/all.*ingredients|ingredients.*all/i.test(latestUser)) {
    const names = state?.recipe?.ingredients?.map(item => item.name).filter(Boolean) ?? []
    return text(`The ingredients are: ${names.join(', ')}.`)
  }
  if (serialized.includes('Pasta Primavera')) return text('The shared recipe was updated.')
  const currentRecipe = state?.recipe ?? {}
  return toolCall(`state-${requestNumber}`, 'ag_ui_update_state', {
    state_updates: {
      recipe: {
        ...currentRecipe,
        title: 'Pasta Primavera',
        ingredients: [
          ...(currentRecipe.ingredients ?? []),
          { icon: '🍝', name: 'Pasta', amount: '200 grams' },
          { icon: '🍅', name: 'Tomato', amount: '1 cup' },
        ],
        instructions: ['Boil the pasta.', 'Add vegetables and tomato.'],
      },
    },
  })
}

function readFeature(messages) {
  const section = readSection(messages, FEATURE_CONTEXT_NAME)
  if (section === undefined) throw new Error('The trusted Dojo feature marker is missing.')
  return section.split('\n', 1)[0]
}

function readSharedState(messages) {
  const section = readSection(messages, 'Current Shared State')
  if (section === undefined) return undefined
  const encoded = section.split('\n\nTo update this state', 1)[0]
  try {
    return JSON.parse(encoded)
  } catch {
    return undefined
  }
}

function readSection(messages, name) {
  const marker = `## ${name}\n`
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const content = messages[messageIndex].content
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = content[blockIndex]
      if (block.type !== 'text') continue
      const start = block.text.lastIndexOf(marker)
      if (start < 0) continue
      const value = block.text.slice(start + marker.length)
      const nextSection = value.indexOf('\n\n## ')
      return value.slice(0, nextSection < 0 ? undefined : nextSection)
    }
  }
  return undefined
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

async function waitForAbort(signal) {
  if (!signal) throw new Error('The scripted disconnect scenario requires a cancellation signal.')
  if (signal.aborted) return
  await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
}

function toolCall(id, name, args) {
  const encoded = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: CallId(id), name, argumentsDelta: encoded },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(id), name, arguments: encoded } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function text(value) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export const name = 'dojo-scripted-model'
export const inject = ['llm']

export function apply(ctx) {
  ctx.llm.registerAdapter(['dojo-scripted'], new DojoScriptedAdapter())
}
