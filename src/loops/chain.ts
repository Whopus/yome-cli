import { callLLMStream, callLLM, extractText } from '../llm.js';
import type { AgentLoop, AgentLoopContext, AgentLoopCallbacks, UserInput } from './types.js';
import { userInputAsText } from './types.js';
import type { ContentBlock } from '../types.js';

const MAX_ITERATIONS = 30;

/**
 * Prompt Chaining: decomposes a task into sequential LLM steps.
 *
 * Step 1 (planner): LLM generates a plan with numbered steps.
 * Step 2..N: each step is executed as a separate sub-agent loop with tool access.
 * A programmatic gate checks each step's output before proceeding.
 *
 * Flow: In → LLM Plan → [Step1 → Gate → Step2 → Gate → ...] → Out
 */
export class ChainAgentLoop implements AgentLoop {
  readonly name = 'chain';
  readonly description = 'Prompt chaining: plan then execute steps sequentially with gates';

  async run(
    userMessage: UserInput,
    ctx: AgentLoopContext,
    cb: AgentLoopCallbacks,
  ): Promise<void> {
    ctx.messages.push({ role: 'user', content: userMessage });

    let totalInput = 0;
    let totalOutput = 0;

    try {
      // Step 1: Ask LLM to decompose the task into a numbered plan
      const planResponse = await callLLM(ctx.config, ctx.systemPrompt, [
        ...ctx.messages,
        {
          role: 'user',
          content:
            'Break the user\'s request into 2-5 concrete numbered steps. ' +
            'Output ONLY a JSON array of step descriptions, e.g. ["step 1 desc", "step 2 desc"]. ' +
            'No other text.',
        },
      ]);
      totalInput += planResponse.usage.input_tokens;
      totalOutput += planResponse.usage.output_tokens;

      const planText = extractText(planResponse);
      let steps: string[];
      try {
        const match = planText.match(/\[[\s\S]*\]/);
        steps = match ? JSON.parse(match[0]) : [userInputAsText(userMessage)];
      } catch {
        // If LLM doesn't produce valid JSON, fall through to simple mode
        steps = [userInputAsText(userMessage)];
      }

      cb.onTextDelta(`**Plan** (${steps.length} steps)\n`);
      steps.forEach((s, i) => cb.onTextDelta(`${i + 1}. ${s}\n`));
      cb.onTextDelta('\n---\n\n');

      // Step 2..N: execute each step with full tool access
      const stepResults: string[] = [];

      for (let i = 0; i < steps.length; i++) {
        const stepPrompt =
          `You are executing step ${i + 1}/${steps.length} of a plan.\n` +
          `Overall task: ${userMessage}\n` +
          `Current step: ${steps[i]}\n` +
          (stepResults.length > 0
            ? `Previous steps completed:\n${stepResults.map((r, j) => `Step ${j + 1}: ${r}`).join('\n')}\n`
            : '') +
          `Execute this step now. Be concise.`;

        // Sub-agent loop for this step (with streaming + tools)
        const stepMessages = [...ctx.messages];
        stepMessages.push({ role: 'user', content: stepPrompt });

        let stepText = '';

        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
          const response = await callLLMStream(
            ctx.config,
            ctx.systemPrompt,
            stepMessages,
            ctx.tools,
            (event) => {
              if (event.type === 'text_delta' && event.text) {
                stepText += event.text;
                cb.onTextDelta(event.text);
              }
            },
          );

          totalInput += response.usage.input_tokens;
          totalOutput += response.usage.output_tokens;
          stepMessages.push({ role: 'assistant', content: response.content });

          const toolUseBlocks = response.content.filter(
            (b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use',
          );

          if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') break;

          const toolResults: ContentBlock[] = [];
          for (const block of toolUseBlocks) {
            cb.onToolUse(block.name, block.input);
            const result = await ctx.executeTool(block.name, block.input);
            cb.onToolResult(block.name, result);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
          }
          stepMessages.push({ role: 'user', content: toolResults });
        }

        stepResults.push(stepText.slice(0, 500) || '(completed)');

        // Gate: verify step completed (programmatic check - non-empty output)
        if (!stepText.trim()) {
          cb.onTextDelta(`\n**Gate failed at step ${i + 1}** - no output produced.\n`);
          break;
        }

        if (i < steps.length - 1) {
          cb.onTextDelta(`\n\n---\n**Step ${i + 1} complete. Proceeding to step ${i + 2}...**\n\n`);
        }
      }

      // Record the final exchange in main context
      ctx.messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: stepResults.join('\n\n') }],
      });
    } catch (err: any) {
      cb.onError(err);
      return;
    }

    cb.onDone({ inputTokens: totalInput, outputTokens: totalOutput });
  }
}
