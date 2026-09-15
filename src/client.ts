/**
 * AG-UI client companion for the stateful dsh-ag-ui gateway.
 * @module dsh-ag-ui/client
 */

import { HttpAgent } from '@ag-ui/client'
import type { Message, RunAgentInput } from '@ag-ui/client'

function admittedRole(message: Message): boolean {
  return message.role === 'user' || message.role === 'tool'
}

/**
 * Keep only messages that can admit work at the stateful gateway. The client
 * retains its complete history; only this run's wire input is narrowed.
 * Assistant placement does not acknowledge earlier input. Keep every user and
 * Tool message and leave admission deduplication to the gateway. The official
 * A2UI middleware's final synthetic pair must reach gateway validation intact.
 */
export function prepareDshRunInput(input: RunAgentInput): RunAgentInput {
  const props: unknown = input.forwardedProps
  const pairStart = typeof props === 'object' && props !== null && Object.hasOwn(props, 'a2uiAction')
    ? Math.max(0, input.messages.length - 2)
    : input.messages.length
  return {
    ...input,
    messages: [
      ...input.messages.slice(0, pairStart).filter(admittedRole),
      ...input.messages.slice(pairStart),
    ],
  }
}

/** `HttpAgent` whose wire input matches dsh-ag-ui's stateful admission contract. */
export class DshHttpAgent extends HttpAgent {
  protected override requestInit(input: RunAgentInput): RequestInit {
    return super.requestInit(prepareDshRunInput(input))
  }
}
