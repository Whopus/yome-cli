import { callLLM, extractText, callLLMStream } from '../llm.js';
import type { AgentLoop, AgentLoopContext, AgentLoopCallbacks, UserInput } from './types.js';
import { userInputAsText } from './types.js';
import type { ContentBlock, AgentMessage } from '../types.js';

const MAX_WORKER_ITERATIONS = 15;

/**
 * Orchestrator-Workers: a central LLM dynamically breaks down the task,
 * delegates subtasks to worker LLM calls (with tools), then synthesizes results.
 *
 * Flow: In → Orchestrator → [Worker1, Worker2, ...] (parallel) → Synthesizer → Out
 */
export class OrchestratorAgentLoop implements AgentLoop {
  readonly name = 'orchestrator';
  readonly description = 'Orchestrator-workers: decompose, delegate in parallel, synthesize';

  async run(
    userMessage: UserInput,
    ctx: AgentLoopContext,
    cb: AgentLoopCallbacks,
  ): Promise<void> {
    ctx.messages.push({ role: 'user', content: userMessage });

    let totalInput = 0;
    let totalOutput = 0;

    try {
      // Step 1: Orchestrator decomposes the task
      const decomposeResponse = await callLLM(ctx.config, ctx.systemPrompt, [
        ...ctx.messages,
        {
          role: 'user',
          content:
            'Break this task into independent subtasks that can be executed in parallel. ' +
            'Output ONLY a JSON array of objects: [{"id": 1, "task": "description"}, ...]. ' +
            'Keep it to 2-5 subtasks. No other text.',
        },
      ]);
      totalInput += decomposeResponse.usage.input_tokens;
      totalOutput += decomposeResponse.usage.output_tokens;

      const decomposeText = extractText(decomposeResponse);
      let subtasks: { id: number; task: string }[];
      try {
        const match = decomposeText.match(/\[[\s\S]*\]/);
        subtasks = match ? JSON.parse(match[0]) : [{ id: 1, task: userInputAsText(userMessage) }];
      } catch {
        subtasks = [{ id: 1, task: userInputAsText(userMessage) }];
      }

      cb.onTextDelta(`**Orchestrator** dispatching ${subtasks.length} workers:\n`);
      subtasks.forEach((s) => cb.onTextDelta(`- Worker ${s.id}: ${s.task}\n`));
      cb.onTextDelta('\n');

      // Step 2: Execute workers in parallel
      const workerResults = await Promise.all(
        subtasks.map((subtask) =>
          this.runWorker(subtask, ctx, cb).then((r) => {
            totalInput += r.inputTokens;
            totalOutput += r.outputTokens;
            return r;
          }),
        ),
      );

      // Step 3: Synthesizer combines results
      cb.onTextDelta('\n---\n**Synthesizing results...**\n\n');

      const synthesisContext =
        `Original task: ${userMessage}\n\n` +
        workerResults
          .map((r) => `## Worker ${r.id} (${r.task})\n${r.result}`)
          .join('\n\n');

      const synthesizeMessages: AgentMessage[] = [
        ...ctx.messages,
        {
          role: 'user',
          content:
            `Here are the results from parallel workers. Synthesize them into a coherent final answer.\n\n${synthesisContext}`,
        },
      ];

      const synthResponse = await callLLMStream(
        ctx.config,
        ctx.systemPrompt,
        synthesizeMessages,
        [],
        (event) => {
          if (event.type === 'text_delta' && event.text) {
            cb.onTextDelta(event.text);
          }
        },
      );
      totalInput += synthResponse.usage.input_tokens;
      totalOutput += synthResponse.usage.output_tokens;

      ctx.messages.push({ role: 'assistant', content: synthResponse.content });
    } catch (err: any) {
      cb.onError(err);
      return;
    }

    cb.onDone({ inputTokens: totalInput, outputTokens: totalOutput });
  }

  private async runWorker(
    subtask: { id: number; task: string },
    ctx: AgentLoopContext,
    cb: AgentLoopCallbacks,
  ): Promise<{ id: number; task: string; result: string; inputTokens: number; outputTokens: number }> {
    const workerMessages: AgentMessage[] = [
      { role: 'user', content: `Execute this subtask: ${subtask.task}\nBe concise and focused.` },
    ];
    let inputTokens = 0;
    let outputTokens = 0;
    let resultText = '';

    for (let i = 0; i < MAX_WORKER_ITERATIONS; i++) {
      const response = await callLLMStream(
        ctx.config,
        ctx.systemPrompt,
        workerMessages,
        ctx.tools,
        (event) => {
          if (event.type === 'text_delta' && event.text) {
            resultText += event.text;
          }
        },
      );

      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      workerMessages.push({ role: 'assistant', content: response.content });

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
      workerMessages.push({ role: 'user', content: toolResults });
    }

    return { id: subtask.id, task: subtask.task, result: resultText || '(no output)', inputTokens, outputTokens };
  }
}
