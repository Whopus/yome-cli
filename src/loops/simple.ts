import { callLLMStream } from '../llm.js';
import type { AgentLoop, AgentLoopContext, AgentLoopCallbacks, UserInput } from './types.js';
import type { ContentBlock } from '../types.js';
import { REJECT_SENTINEL } from '../tools/index.js';

const MAX_ITERATIONS = 30;

export class SimpleAgentLoop implements AgentLoop {
  readonly name = 'simple';
  readonly description = 'Sequential tool-call loop (default)';

  async run(
    userMessage: UserInput,
    ctx: AgentLoopContext,
    cb: AgentLoopCallbacks,
  ): Promise<void> {
    ctx.messages.push({ role: 'user', content: userMessage });

    let totalInput = 0;
    let totalOutput = 0;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      try {
        const response = await callLLMStream(
          ctx.config,
          ctx.systemPrompt,
          ctx.messages,
          ctx.tools,
          (event) => {
            if (event.type === 'text_delta' && event.text) {
              cb.onTextDelta(event.text);
            }
          },
        );

        totalInput += response.usage.input_tokens;
        totalOutput += response.usage.output_tokens;
        ctx.messages.push({ role: 'assistant', content: response.content });

        const toolUseBlocks = response.content.filter(
          (b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use',
        );

        if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
          cb.onDone({ inputTokens: totalInput, outputTokens: totalOutput });
          return;
        }

        const toolResults: ContentBlock[] = [];
        let userRejected = false;
        for (const block of toolUseBlocks) {
          if (userRejected) {
            // Short-circuit remaining tool_uses in this batch with a synthetic
            // rejection so the API stays paired (every tool_use needs a result).
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `${REJECT_SENTINEL} Skipped — user rejected an earlier tool use in this turn.`,
            });
            continue;
          }
          cb.onToolUse(block.name, block.input);
          const result = await ctx.executeTool(block.name, block.input);
          cb.onToolResult(block.name, result);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
          if (typeof result === 'string' && result.startsWith(REJECT_SENTINEL)) {
            userRejected = true;
          }
        }

        ctx.messages.push({ role: 'user', content: toolResults });
      } catch (err: any) {
        cb.onError(err);
        return;
      }
    }

    cb.onDone({ inputTokens: totalInput, outputTokens: totalOutput });
  }
}
