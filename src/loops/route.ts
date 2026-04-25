import { callLLM, extractText, callLLMStream } from '../llm.js';
import type { AgentLoop, AgentLoopContext, AgentLoopCallbacks, UserInput } from './types.js';
import type { ContentBlock } from '../types.js';
import { REJECT_SENTINEL } from '../tools/index.js';

const MAX_ITERATIONS = 30;

interface Route {
  name: string;
  description: string;
  systemPrompt: string;
}

const ROUTES: Route[] = [
  {
    name: 'code',
    description: 'Writing, editing, debugging, or refactoring code',
    systemPrompt:
      'You are a coding specialist. Focus on writing clean, correct code. ' +
      'Read files before editing. Use tools to verify your changes compile/run.',
  },
  {
    name: 'analyze',
    description: 'Reading, understanding, explaining, or reviewing code/files',
    systemPrompt:
      'You are an analysis specialist. Focus on reading and understanding code. ' +
      'Provide clear explanations. Use Read/Grep/Glob to gather information before answering.',
  },
  {
    name: 'shell',
    description: 'Running commands, managing files, git operations, build/test tasks',
    systemPrompt:
      'You are a shell operations specialist. Focus on running commands efficiently. ' +
      'Prefer Bash tool for system operations. Be careful with destructive commands.',
  },
  {
    name: 'general',
    description: 'General questions, planning, brainstorming, or anything else',
    systemPrompt:
      'You are a helpful assistant. Answer the user concisely and accurately. ' +
      'Use tools only when needed to verify facts or gather information.',
  },
];

/**
 * Routing: classify input then dispatch to a specialized handler.
 *
 * Flow: In → LLM Router → [route1 | route2 | route3 | ...] → Out
 *
 * Each route has a specialized system prompt so the LLM focuses on that domain.
 */
export class RouteAgentLoop implements AgentLoop {
  readonly name = 'route';
  readonly description = 'Routing: classify input then dispatch to specialized handler';

  async run(
    userMessage: UserInput,
    ctx: AgentLoopContext,
    cb: AgentLoopCallbacks,
  ): Promise<void> {
    ctx.messages.push({ role: 'user', content: userMessage });

    let totalInput = 0;
    let totalOutput = 0;

    try {
      // Step 1: Classify
      const routeList = ROUTES.map((r) => `- ${r.name}: ${r.description}`).join('\n');
      const classifyResponse = await callLLM(ctx.config, 'You are a router.', [
        {
          role: 'user',
          content:
            `Classify this request into exactly one category. Reply with ONLY the category name.\n\nCategories:\n${routeList}\n\nRequest: ${userMessage}`,
        },
      ]);
      totalInput += classifyResponse.usage.input_tokens;
      totalOutput += classifyResponse.usage.output_tokens;

      const classification = extractText(classifyResponse).trim().toLowerCase();
      const route = ROUTES.find((r) => classification.includes(r.name)) ?? ROUTES[ROUTES.length - 1];

      cb.onTextDelta(`*[routed to: ${route.name}]*\n\n`);

      // Step 2: Execute with specialized system prompt
      const specializedPrompt = `${route.systemPrompt}\n\n${ctx.systemPrompt}`;

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const response = await callLLMStream(
          ctx.config,
          specializedPrompt,
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
        ctx.messages.push({ role: 'user', content: toolResults });
      }
    } catch (err: any) {
      cb.onError(err);
      return;
    }

    cb.onDone({ inputTokens: totalInput, outputTokens: totalOutput });
  }
}
