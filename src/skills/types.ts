export interface SkillFrontmatter {
  name?: string;
  description?: string;
  'allowed-tools'?: string | string[];
  'argument-hint'?: string;
  when_to_use?: string;
  model?: string;
  context?: 'inline' | 'fork';
}

export interface Skill {
  name: string;
  description: string;
  allowedTools: string[];
  argumentHint?: string;
  whenToUse?: string;
  model?: string;
  context: 'inline' | 'fork';
  source: 'user' | 'project';
  skillDir: string;
  markdownContent: string;
  getPrompt: (args: string) => string;
}
