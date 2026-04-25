import { callLLM, extractText, callLLMStream } from '../llm.js';
import type { AgentLoop, AgentLoopContext, AgentLoopCallbacks, UserInput } from './types.js';
import type { ContentBlock, AgentMessage } from '../types.js';
import { REJECT_SENTINEL } from '../tools/index.js';

const MAX_GENERATOR_ITERATIONS = 20;
const MAX_EVAL_ROUNDS = 3;

/**
 * Evaluator-Optimizer: one LLM generates a solution with tools,
 * another evaluates and provides feedback. Loop until accepted.
 *
 * Flow: In → Generator (with tools) → Evaluator → [accept | reject+feedback → Generator] → Out
 */
export class EvaluatorAgentLoop implements AgentLoop {
  readonly name = 'evaluator';
  readonly description = 'Evaluator-optimizer: generate, evaluate, refine loop';

  async run(
    userMessage: UserInput,
    ctx: AgentLoopContext,
    cb: AgentLoopCallbacks,
  ): Promise<void> {
    ctx.messages.push({ role: 'user', content: userMessage });

    let totalInput = 0;
    let totalOutput = 0;

    try {
      let lastSolution = '';
      let feedback = '';

      for (let round = 0; round < MAX_EVAL_ROUNDS; round++) {
        // Generator phase
        if (round > 0) {
          cb.onTextDelta(`\n---\n**Round ${round + 1}: refining based on feedback...**\n\n`);
        }

        const generatorPrompt =
          round === 0
            ? userMessage
            : `The evaluator rejected your previous solution with this feedback:\n\n${feedback}\n\nOriginal task: ${userMessage}\n\nPlease revise your solution.`;

        const genMessages: AgentMessage[] = [...ctx.messages];
        if (round > 0) {
          genMessages.push({ role: 'user', content: generatorPrompt });
        }

        let solutionText = '';

        for (let i = 0; i < MAX_GENERATOR_ITERATIONS; i++) {
          const response = await callLLMStream(
            ctx.config,
            ctx.systemPrompt,
            genMessages,
            ctx.tools,
            (event) => {
              if (event.type === 'text_delta' && event.text) {
                solutionText += event.text;
                cb.onTextDelta(event.text);
              }
            },
          );

          totalInput += response.usage.input_tokens;
          totalOutput += response.usage.output_tokens;
          genMessages.push({ role: 'assistant', content: response.content });

          const toolUseBlocks = response.content.filter(
            (b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use',
          );

          if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') break;

          const toolResults: ContentBlock[] = [];
          let userRejected = false;
          for (const block of toolUseBlocks) {
            if (userRejected) {
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `${REJECT_SENTINEL} Skipped — user rejected an earlier tool use in this turn.` });
              continue;
            }
            cb.onToolUse(block.name, block.input);
            const result = await ctx.executeTool(block.name, block.input);
            cb.onToolResult(block.name, result);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
            if (typeof result === 'string' && result.startsWith(REJECT_SENTINEL)) userRejected = true;
          }
          genMessages.push({ role: 'user', content: toolResults });
        }

        lastSolution = solutionText;

        // Last round: skip evaluation, accept as-is
        if (round === MAX_EVAL_ROUNDS - 1) break;

        // Evaluator phase
        cb.onTextDelta('\n\n*Evaluating...*\n');

        const evalResponse = await callLLM(
          ctx.config,
          'You are a critical evaluator. Judge whether the solution meets the task requirements. ' +
            'Reply with a JSON object: {"accepted": true/false, "feedback": "your feedback"}. ' +
            'Only accept if the solution is complete and correct. No other text.',
          [
            {
              role: 'user',
              content: `Task: ${userMessage}\n\nSolution:\n${lastSolution.slice(0, 4000)}`,
            },
          ],
        );
        totalInput += evalResponse.usage.input_tokens;
        totalOutput += evalResponse.usage.output_tokens;

        const evalText = extractText(evalResponse);
        let evalResult: { accepted: boolean; feedback: string };
        try {
          const match = evalText.match(/\{[\s\S]*\}/);
          evalResult = match ? JSON.parse(match[0]) : { accepted: true, feedback: '' };
        } catch {
          evalResult = { accepted: true, feedback: '' };
        }

        if (evalResult.accepted) {
          cb.onTextDelta('*Accepted.*\n');
          break;
        }

        feedback = evalResult.feedback || 'Solution needs improvement.';
        cb.onTextDelta(`*Rejected: ${feedback}*\n`);
      }

      // Record final solution in context
      ctx.messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: lastSolution }],
      });
    } catch (err: any) {
      cb.onError(err);
      return;
    }

    cb.onDone({ inputTokens: totalInput, outputTokens: totalOutput });
  }
}
