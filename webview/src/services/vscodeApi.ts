// VS Code API integration for the React app
interface VsCodeWebviewApi {
  postMessage: (message: unknown) => void;
}

declare global {
  interface Window {
    vscode: VsCodeWebviewApi;
  }
}

export interface Message {
  id: string;
  type: 'user' | 'agent' | 'system';
  content: string;
  systemType?: 'session' | 'debug' | 'error' | 'warning';
  details?: string;
  timestamp?: string;
}

// AgentSource enum values - injected from the extension (from @salesforce/agents)
// This ensures we use the exact same values as the library
declare global {
  interface Window {
    AgentSource: {
      SCRIPT: string;
      PUBLISHED: string;
    };
  }
}

// AgentSource enum values are lowercase: 'script' and 'published'
export const AgentSource = window.AgentSource || {
  SCRIPT: 'script',
  PUBLISHED: 'published'
};

export type AgentSource = typeof AgentSource.SCRIPT | typeof AgentSource.PUBLISHED;

export interface AgentInfo {
  name: string;
  id: string;
  type: AgentSource;
  activeVersion?: number;
}

export interface SessionListEntry {
  sessionId: string;
  timestamp?: string;
  sessionType?: 'simulated' | 'live' | 'published';
  firstUserMessage?: string;
}

export interface TraceHistoryMessageEntry {
  storageKey: string;
  agentId: string;
  sessionId: string;
  planId: string;
  messageId?: string;
  userMessage?: string;
  timestamp?: string;
  trace: unknown;
}

export interface TraceData {
  sessionId: string;
  planId: string;
  steps: TraceStep[];
  startTime: string;
  endTime?: string;
}

export interface TraceStep {
  type:
    | 'userMessage'
    | 'topicSelection'
    | 'topic'
    | 'actionSelection'
    | 'action'
    | 'responseValidation'
    | 'agentResponse';
  timing: string;
  data: unknown;
}

type MessageHandler<T = unknown> = (data: T) => void;
// Handlers of varying payload types are stored together in a single map, so the
// stored function type must accept anything a caller's specific handler could
// require (contravariantly, that means a parameter type of `never`).
type StoredMessageHandler = (data: never) => void;

class VSCodeApiService {
  private vscode = window.vscode;
  private messageHandlers: Map<string, Set<StoredMessageHandler>> = new Map();

  constructor() {
    // Listen for messages from VS Code
    window.addEventListener('message', event => {
      const message = event.data;
      const handlers = this.messageHandlers.get(message.command);
      if (handlers) {
        handlers.forEach(handler => handler(message.data as never));
      }
    });

    // Apply editor theme token colors as CSS custom properties for syntax highlighting.
    // Uses a <style> tag instead of inline styles so VS Code theme resets don't wipe them.
    this.onMessage('themeTokenColors', (colors: Record<string, string | undefined>) => {
      let styleEl = document.getElementById('json-theme-colors') as HTMLStyleElement | null;
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'json-theme-colors';
        document.head.appendChild(styleEl);
      }

      const mapping: Record<string, string> = {
        key: '--json-token-key',
        string: '--json-token-string',
        number: '--json-token-number',
        boolean: '--json-token-boolean',
        null: '--json-token-null'
      };

      const props: string[] = [];
      for (const [token, prop] of Object.entries(mapping)) {
        if (colors[token]) {
          props.push(`${prop}: ${colors[token]};`);
        }
      }

      // Replace entire content — clears old theme colors and falls back to
      // --vscode-debugTokenExpression-* when the new theme has no match
      styleEl.textContent = props.length > 0 ? `:root { ${props.join(' ')} }` : '';
    });
  }

  // Register a handler for specific message types
  onMessage<T = unknown>(command: string, handler: MessageHandler<T>): () => void {
    if (!this.messageHandlers.has(command)) {
      this.messageHandlers.set(command, new Set());
    }
    const handlers = this.messageHandlers.get(command)!;
    handlers.add(handler);

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.messageHandlers.delete(command);
      }
    };
  }

  // Send messages to VS Code
  private postMessage(command: string, data?: unknown) {
    this.vscode?.postMessage({ command, data });
  }

  // Dispatch a synthetic message to local listeners only (not sent to the extension).
  // Useful for optimistic UI updates that should mirror an extension-driven event.
  emitLocal(command: string, data?: unknown) {
    const handlers = this.messageHandlers.get(command);
    if (handlers) {
      handlers.forEach(handler => handler(data as never));
    }
  }

  // Agent session management
  startSession(agentId: string, options?: { isLiveMode?: boolean; agentSource?: string }) {
    this.postMessage('startSession', { agentId, ...options });
  }

  endSession(options?: { restarting?: boolean }) {
    this.postMessage('endSession', options);
  }

  sendChatMessage(message: string) {
    this.postMessage('sendChatMessage', { message });
  }

  // Debug mode
  setApexDebugging(enabled: boolean) {
    this.postMessage('setApexDebugging', enabled);
  }

  // Agent management
  getAvailableAgents() {
    this.postMessage('getAvailableAgents');
  }

  // Trace data
  getTraceData() {
    this.postMessage('getTraceData');
  }

  // Clear chat
  clearChat() {
    this.postMessage('clearChat');
  }

  // Clear messages in the panel
  clearMessages() {
    this.postMessage('clearMessages');
  }

  // Get configuration values
  getConfiguration(section: string) {
    this.postMessage('getConfiguration', { section });
  }

  // Execute a VSCode command
  executeCommand(commandId: string, ...args: unknown[]) {
    this.postMessage('executeCommand', { commandId, args });
  }

  // Open a URL in the default browser
  openUrl(url: string) {
    this.postMessage('openUrl', { url });
  }

  // Notify the extension about the selected agent ID
  setSelectedAgentId(agentId: string, agentSource?: AgentSource) {
    this.postMessage('setSelectedAgentId', { agentId, agentSource });
  }

  // Load conversation history for an agent without starting a session
  loadAgentHistory(agentId: string, agentSource?: AgentSource) {
    this.postMessage('loadAgentHistory', { agentId, agentSource });
  }

  // Set live mode preference
  setLiveMode(isLiveMode: boolean) {
    this.postMessage('setLiveMode', { isLiveMode });
  }

  // Request initial live mode state
  getInitialLiveMode() {
    this.postMessage('getInitialLiveMode');
  }


  openTraceJson(entry: TraceHistoryMessageEntry) {
    this.postMessage('openTraceJson', { entry });
  }

  // Session history
  listSessions(agentId: string, agentSource?: AgentSource) {
    this.postMessage('listSessions', { agentId, agentSource });
  }

  previewSession(
    agentId: string,
    sessionId: string,
    options?: { agentSource?: AgentSource; sessionType?: 'simulated' | 'live' | 'published' }
  ) {
    this.postMessage('previewSession', { agentId, sessionId, ...options });
  }

  clearPreviewedSession() {
    this.postMessage('clearPreviewedSession');
  }

  // Test support - send test response messages
  postTestMessage(command: string, data?: unknown) {
    this.postMessage(command, data);
  }
}

export const vscodeApi = new VSCodeApiService();
