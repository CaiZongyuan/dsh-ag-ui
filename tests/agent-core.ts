import type { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'

/** Mount the supported minimal Agent runtime used by in-process gateway tests. */
export async function mountTestAgentCore(ctx: Context, persona = 'Test persona.'): Promise<void> {
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      persona,
    },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
}
