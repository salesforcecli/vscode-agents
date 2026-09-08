import { AgentSource, PlannerResponse } from '@salesforce/agents';
import { getAllHistory, type TranscriptEntry } from '@salesforce/agents/lib/utils';
import type { TraceHistoryEntry } from '../../../utils/traceHistory';
import * as vscode from 'vscode';
import type { AgentViewState } from '../state/agentViewState';
import type { WebviewMessageSender } from '../handlers/webviewMessageSender';
import { getAgentStorageKey } from '../agent/agentUtils';
import { listSessionsForAgent, type SessionListEntry } from '../session/sessionHistoryService';

/**
 * Manages conversation and trace history
 */
export class HistoryManager {
  constructor(
    private readonly state: AgentViewState,
    private readonly messageSender: WebviewMessageSender
  ) {}

  /**
   * Load conversation history for an agent and send it to the webview
   */
  async loadAndSendConversationHistory(agentId: string, agentSource: AgentSource): Promise<boolean> {
    try {
      const transcriptEntries = await this.loadConversationHistoryData(agentId, agentSource);

      if (transcriptEntries.length > 0) {
        const historyMessages = this.convertTranscriptToMessages(transcriptEntries);

        if (historyMessages.length > 0) {
          this.messageSender.sendConversationHistory(historyMessages);
          await this.state.setConversationDataAvailable(true);
          return true;
        }
      }
    } catch (err) {
      console.error('Could not load conversation history:', err);
    }

    await this.state.setConversationDataAvailable(false);
    return false;
  }

  /**
   * Converts transcript entries to message format, sorted chronologically
   */
  private convertTranscriptToMessages(
    transcriptEntries: Array<{ text?: string; timestamp: string; sessionId: string; role: string }>
  ): Array<{ id: string; type: string; content: string; timestamp: number }> {
    return transcriptEntries
      .filter(entry => entry.text)
      .map(entry => ({
        id: `${entry.timestamp}-${entry.sessionId}`,
        type: entry.role === 'user' ? 'user' : 'agent',
        content: entry.text || '',
        timestamp: new Date(entry.timestamp).getTime()
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Extracts the start time from a trace's UserInputStep for sorting
   */
  private getTraceStartTime(trace: unknown): number | undefined {
    try {
      const traceObj = trace as { plan?: Array<{ type?: string; startExecutionTime?: number }> };
      if (traceObj?.plan && Array.isArray(traceObj.plan)) {
        const userInputStep = traceObj.plan.find(step => step.type === 'UserInputStep');
        if (userInputStep?.startExecutionTime) {
          return userInputStep.startExecutionTime;
        }
      }
    } catch {
      // Fall through to default
    }
    return undefined;
  }

  /**
   * Extracts user message from trace data
   */
  private extractUserMessageFromTrace(trace: unknown): string | undefined {
    try {
      // Trace structure: { plan: Array<{ type: string, message?: string, ... }> }
      const traceObj = trace as { plan?: Array<{ type?: string; message?: string; stepType?: string }> };
      if (traceObj?.plan && Array.isArray(traceObj.plan)) {
        // Find the first UserInputStep which contains the user message
        const userInputStep = traceObj.plan.find(
          step => step.type === 'UserInputStep' || step.stepType === 'UserInputStep'
        );
        if (userInputStep?.message) {
          return userInputStep.message;
        }
      }
    } catch (error) {
      console.error('Error extracting user message from trace:', error);
    }
    return undefined;
  }

  /**
   * Load trace history for an agent and send it to the webview
   */
  async loadAndSendTraceHistory(agentId: string, agentSource: AgentSource): Promise<void> {
    try {
      const entries = await this.loadTraceHistoryData(agentId, agentSource);

      // Send trace history to populate the history list
      this.messageSender.sendTraceHistory(agentId, entries);

      // Send current or latest trace data
      if (entries.length > 0) {
        const currentEntry = this.state.currentPlanId
          ? entries.find(entry => entry.planId === this.state.currentPlanId)
          : undefined;
        const entryToSend = currentEntry || entries[entries.length - 1];
        this.messageSender.sendTraceData(entryToSend.trace);
      }
    } catch (error) {
      console.error('Could not load trace history:', error);
      this.messageSender.sendTraceHistory(agentId, []);
    }
  }

  /**
   * Opens a trace JSON entry in the editor
   * Creates a virtual document instead of saving to disk
   */
  async openTraceJsonEntry(entryData: TraceHistoryEntry | undefined): Promise<void> {
    if (!entryData || typeof entryData !== 'object' || !entryData.trace) {
      vscode.window.showErrorMessage('Unable to open trace JSON: Missing trace details.');
      return;
    }

    try {
      // Create a virtual document URI instead of saving to disk
      const traceJson = JSON.stringify(entryData.trace, null, 2);
      const uri = vscode.Uri.parse(`untitled:${entryData.planId || 'trace'}.json`);
      const document = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(0, 0), traceJson);
      await vscode.workspace.applyEdit(edit);
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Unable to open trace JSON: ${errorMessage}`);
      console.error('Unable to open trace JSON:', error);
    }
  }

  /**
   * Shows history or placeholder for an agent
   * Uses atomic setConversation message to avoid visual blink
   */
  async showHistoryOrPlaceholder(agentId: string, agentSource: AgentSource): Promise<void> {
    try {
      // Load histories + the cached-session list in parallel.
      // The session list is used to identify the most-recent sessionId/type so
      // the webview can display Resume vs Start on the start button.
      const [traceEntries, transcriptEntries, sessions] = await Promise.all([
        this.loadTraceHistoryData(agentId, agentSource),
        this.loadConversationHistoryData(agentId, agentSource),
        listSessionsForAgent(agentId, agentSource).catch(() => [] as SessionListEntry[])
      ]);

      // Send trace history
      this.messageSender.sendTraceHistory(agentId, traceEntries);

      // Convert and send conversation history
      const historyMessages = this.convertTranscriptToMessages(transcriptEntries);
      const hasHistory = historyMessages.length > 0;
      await this.state.setConversationDataAvailable(hasHistory);

      // If a conversation is loaded, mark it as resumable. Newest session is first.
      const previewSessionInfo = hasHistory && sessions.length > 0
        ? { sessionId: sessions[0].sessionId, sessionType: sessions[0].sessionType }
        : null;
      this.state.previewedSessionId = previewSessionInfo?.sessionId;
      this.messageSender.sendSetConversation(historyMessages, !hasHistory, previewSessionInfo);

      // Send current or latest trace data
      if (traceEntries.length > 0) {
        const currentEntry = this.state.currentPlanId
          ? traceEntries.find(entry => entry.planId === this.state.currentPlanId)
          : undefined;
        const entryToSend = currentEntry || traceEntries[traceEntries.length - 1];
        this.messageSender.sendTraceData(entryToSend.trace);
      }
    } catch (err) {
      console.error('Error loading history:', err);
      await this.state.setConversationDataAvailable(false);
      this.messageSender.sendSetConversation([], true, null);
    }
  }

  /**
   * Loads only the trace history for a specific sessionId (from disk) and pushes
   * it to the webview. Used when the tracer tab is opened while previewing a
   * session — we don't want to re-render the chat, only ensure the tracer has
   * the right traces.
   */
  async loadAndSendTracesForSession(
    agentId: string,
    agentSource: AgentSource,
    sessionId: string
  ): Promise<void> {
    const agentStorageKey = getAgentStorageKey(agentId, agentSource);
    let traces: PlannerResponse[] = [];
    try {
      const history = await getAllHistory(agentStorageKey, sessionId);
      traces = history.traces || [];
    } catch (err) {
      console.error('Could not load traces for session:', err);
    }

    const sortedTraces = [...traces].sort((a: PlannerResponse, b: PlannerResponse) => {
      const timeA = this.getTraceStartTime(a) ?? Infinity;
      const timeB = this.getTraceStartTime(b) ?? Infinity;
      return timeA - timeB;
    });
    const traceEntries: TraceHistoryEntry[] = sortedTraces.map((trace: PlannerResponse, index) => {
      const planId = trace.planId || `plan-${index}`;
      const startTime = this.getTraceStartTime(trace);
      const timestamp = startTime ? new Date(startTime).toISOString() : new Date().toISOString();
      return {
        storageKey: agentStorageKey,
        agentId,
        sessionId: trace.sessionId || sessionId,
        planId,
        userMessage: this.extractUserMessageFromTrace(trace),
        timestamp,
        trace
      };
    });

    this.messageSender.sendTraceHistory(agentId, traceEntries);
    if (traceEntries.length > 0) {
      this.messageSender.sendTraceData(traceEntries[traceEntries.length - 1].trace);
    } else {
      this.messageSender.sendTraceData({ plan: [], planId: '', sessionId: '' });
    }
  }

  /**
   * Loads transcript and traces for a specific sessionId (from disk) and pushes
   * them to the webview, without starting a session. Used by the History tab
   * to preview a prior session before the user clicks Start.
   */
  async loadAndSendSessionPreview(
    agentId: string,
    agentSource: AgentSource,
    sessionId: string,
    sessionType?: 'simulated' | 'live' | 'published'
  ): Promise<void> {
    const agentStorageKey = getAgentStorageKey(agentId, agentSource);
    let transcript: TranscriptEntry[] = [];
    let traces: PlannerResponse[] = [];
    try {
      const history = await getAllHistory(agentStorageKey, sessionId);
      transcript = history.transcript || [];
      traces = history.traces || [];
    } catch (err) {
      console.error('Could not load session preview:', err);
    }

    const sortedTraces = [...traces].sort((a: PlannerResponse, b: PlannerResponse) => {
      const timeA = this.getTraceStartTime(a) ?? Infinity;
      const timeB = this.getTraceStartTime(b) ?? Infinity;
      return timeA - timeB;
    });
    const traceEntries: TraceHistoryEntry[] = sortedTraces.map((trace: PlannerResponse, index) => {
      const planId = trace.planId || `plan-${index}`;
      const startTime = this.getTraceStartTime(trace);
      const timestamp = startTime ? new Date(startTime).toISOString() : new Date().toISOString();
      return {
        storageKey: agentStorageKey,
        agentId,
        sessionId: trace.sessionId || sessionId,
        planId,
        userMessage: this.extractUserMessageFromTrace(trace),
        timestamp,
        trace
      };
    });

    const messages = this.convertTranscriptToMessages(transcript);
    const hasMessages = messages.length > 0;
    await this.state.setConversationDataAvailable(hasMessages);
    this.messageSender.sendSetConversation(messages, !hasMessages, { sessionId, sessionType });
    this.messageSender.sendTraceHistory(agentId, traceEntries);
    if (traceEntries.length > 0) {
      this.messageSender.sendTraceData(traceEntries[traceEntries.length - 1].trace);
    }
  }

  /**
   * Loads trace history data without sending to webview
   */
  private async loadTraceHistoryData(agentId: string, agentSource: AgentSource): Promise<TraceHistoryEntry[]> {
    try {
      let history;
      let sessionId: string | undefined;

      // Use agent instance if available AND the session belongs to the requested agent
      // This prevents loading wrong history when switching agents while a session is active
      if (this.state.agentInstance && this.state.sessionId && this.state.sessionAgentId === agentId) {
        history = await this.state.agentInstance.getHistoryFromDisc(this.state.sessionId);
        sessionId = this.state.sessionId;
      } else {
        // Use getAllHistory from library when no active session or session belongs to different agent
        const agentStorageKey = getAgentStorageKey(agentId, agentSource);
        history = await getAllHistory(agentStorageKey, undefined);
        // When using getAllHistory with undefined sessionId, we get all sessions
        // Extract sessionId from the most recent trace if available
        if (history.traces && history.traces.length > 0) {
          const mostRecentTrace = history.traces[history.traces.length - 1];
          sessionId = mostRecentTrace.sessionId;
        }
      }

      // Sort traces by startExecutionTime from UserInputStep (oldest first)
      const sortedTraces = [...(history.traces || [])].sort((a, b) => {
        const timeA = this.getTraceStartTime(a) ?? Infinity;
        const timeB = this.getTraceStartTime(b) ?? Infinity;
        return timeA - timeB;
      });

      const agentStorageKey = getAgentStorageKey(agentId, agentSource);
      const entries = sortedTraces.map((trace, index) => {
        const planId = trace.planId || `plan-${index}`;
        const traceSessionId = trace.sessionId || sessionId || 'unknown';
        const userMessage = this.extractUserMessageFromTrace(trace);
        const startTime = this.getTraceStartTime(trace);
        const timestamp = startTime ? new Date(startTime).toISOString() : new Date().toISOString();

        return {
          storageKey: agentStorageKey,
          agentId: agentId,
          sessionId: traceSessionId,
          planId: planId,
          userMessage: userMessage,
          timestamp,
          trace: trace
        };
      });

      return entries;
    } catch (error) {
      // NoSessionFound is expected for new agents with no previous sessions - don't log as error
      const isExpectedError =
        error instanceof Error && (error.name === 'NoSessionFound' || error.message.includes('No sessions found'));
      if (!isExpectedError) {
        console.error('Could not load trace history:', error);
      }
      return [];
    }
  }

  /**
   * Loads conversation history data without sending to webview
   */
  private async loadConversationHistoryData(agentId: string, agentSource: AgentSource): Promise<TranscriptEntry[]> {
    try {
      let transcriptEntries;

      // Try to use agent instance if available AND the session belongs to the requested agent
      // This prevents loading wrong history when switching agents while a session is active
      if (this.state.agentInstance && this.state.sessionId && this.state.sessionAgentId === agentId) {
        const history = await this.state.agentInstance.getHistoryFromDisc(this.state.sessionId);
        transcriptEntries = history.transcript || [];
      } else {
        // Use getAllHistory from library when no active session or session belongs to different agent
        const agentStorageKey = getAgentStorageKey(agentId, agentSource);
        const history = await getAllHistory(agentStorageKey, undefined);
        transcriptEntries = history.transcript || [];
      }

      return transcriptEntries || [];
    } catch (err) {
      // NoSessionFound is expected for new agents with no previous sessions - don't log as error
      const isExpectedError =
        err instanceof Error && (err.name === 'NoSessionFound' || err.message.includes('No sessions found'));
      if (!isExpectedError) {
        console.error('Could not load conversation history:', err);
      }
      return [];
    }
  }

}
