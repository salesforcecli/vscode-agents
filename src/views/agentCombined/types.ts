import { PreviewableAgent, ProductionAgent, ScriptAgent } from '@salesforce/agents';
import type { TraceHistoryEntry } from '../../utils/traceHistory';

/**
 * Message interface for webview communication
 */
export interface AgentMessage {
  command?: string;
  type?: string;
  message?: string;
  data?: unknown;
  body?: string;
}

/**
 * Custom error for session start cancellation
 */
export class SessionStartCancelledError extends Error {
  constructor() {
    super('Agent session start was cancelled');
    this.name = 'SessionStartCancelledError';
  }
}

/**
 * Session start guard functions
 */
export interface SessionStartGuards {
  ensureActive: () => void;
  isActive: () => boolean;
}

/**
 * Agent instance type union
 */
export type AgentInstance = ScriptAgent | ProductionAgent;

/**
 * Re-export commonly used types
 */
export type { PreviewableAgent, TraceHistoryEntry };
