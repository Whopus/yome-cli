import type { AgentLoop, AgentLoopRegistry } from './types.js';
import { SimpleAgentLoop } from './simple.js';
import { ParallelAgentLoop } from './parallel.js';
import { ChainAgentLoop } from './chain.js';
import { RouteAgentLoop } from './route.js';
import { OrchestratorAgentLoop } from './orchestrator.js';
import { EvaluatorAgentLoop } from './evaluator.js';

export type { AgentLoop, AgentLoopCallbacks, AgentLoopContext, AgentLoopRegistry } from './types.js';

class Registry implements AgentLoopRegistry {
  private loops = new Map<string, AgentLoop>();
  private defaultName = 'simple';

  get(name: string): AgentLoop | undefined {
    return this.loops.get(name);
  }

  list(): AgentLoop[] {
    return Array.from(this.loops.values());
  }

  register(loop: AgentLoop): void {
    this.loops.set(loop.name, loop);
  }

  default(): AgentLoop {
    return this.loops.get(this.defaultName)!;
  }

  setDefault(name: string): boolean {
    if (!this.loops.has(name)) return false;
    this.defaultName = name;
    return true;
  }
}

export function createLoopRegistry(): Registry {
  const registry = new Registry();
  registry.register(new SimpleAgentLoop());
  registry.register(new ParallelAgentLoop());
  registry.register(new ChainAgentLoop());
  registry.register(new RouteAgentLoop());
  registry.register(new OrchestratorAgentLoop());
  registry.register(new EvaluatorAgentLoop());
  return registry;
}
