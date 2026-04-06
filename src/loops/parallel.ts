import { callLLMStream } from '../llm.js';
import type { AgentLoop, AgentLoopContext, AgentLoopCallbacks } from './types.js';
import type { ContentBlock } from '../types.js';

const MAX_ITERATIONS = 30;

export class ParallelAgentLoop implements AgentLoop {
  readonly name = 'parallel';
  readonly description = 'Parallel tool execution loop';

  async run(
    userMessage: string,
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

        // Execute all tools in parallel
        for (const block of toolUseBlocks) {
          cb.onToolUse(block.name, block.input);
        }

        const results = await Promise.all(
          toolUseBlocks.map((block) => ctx.executeTool(block.name, block.input)),
        );

        const toolResults: ContentBlock[] = toolUseBlocks.map((block, idx) => {
          cb.onToolResult(block.name, results[idx]);
          return {
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: results[idx],
          };
        });

        ctx.messages.push({ role: 'user', content: toolResults });
      } catch (err: any) {
        cb.onError(err);
        return;
      }
    }

    cb.onDone({ inputTokens: totalInput, outputTokens: totalOutput });
  }
}
