import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const STATE_DIR = join(homedir(), '.yome');
const STATE_FILE = join(STATE_DIR, 'disabled.json');

interface DisabledState {
  skills: string[];
  agents: string[];
}

function load(): DisabledState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { skills: [], agents: [] };
  }
}

function save(state: DisabledState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

export function isSkillDisabled(name: string): boolean {
  return load().skills.includes(name);
}

export function isAgentDisabled(name: string): boolean {
  return load().agents.includes(name);
}

export function toggleSkill(name: string): boolean {
  const state = load();
  const idx = state.skills.indexOf(name);
  if (idx >= 0) {
    state.skills.splice(idx, 1);
    save(state);
    return true;
  } else {
    state.skills.push(name);
    save(state);
    return false;
  }
}

export function toggleAgent(name: string): boolean {
  const state = load();
  const idx = state.agents.indexOf(name);
  if (idx >= 0) {
    state.agents.splice(idx, 1);
    save(state);
    return true;
  } else {
    state.agents.push(name);
    save(state);
    return false;
  }
}

export function getDisabledSkills(): string[] {
  return load().skills;
}

export function getDisabledAgents(): string[] {
  return load().agents;
}
