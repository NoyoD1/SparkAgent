// Mock data types — 1:1 mirrors what the Pi SDK session/agent state will look like.
// When Phase 2 hooks up real Pi SDK, these types will be replaced by SDK types.

export interface MockWorkspace {
  id: string;
  name: string;
  /** pseudo "industry" tag (能源/交管/QA/...) — just a label, not used yet */
  tag?: string;
  files: MockFile[];
  createdAt: string;
}

export interface MockFile {
  path: string;
  name: string;
  kind: 'file' | 'dir';
}

export interface MockSession {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

export interface ThinkingBlock {
  id: string;
  messageId: string;
  content: string;
  collapsed: boolean;
}

export type ToolCallStatus = 'pending' | 'running' | 'success' | 'error';

export interface ToolCallBlock {
  id: string;
  messageId: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolCallStatus;
  result?: string;
  startedAt: string;
  endedAt?: string;
}
