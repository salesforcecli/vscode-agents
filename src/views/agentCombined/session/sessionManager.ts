import type * as vscode from 'vscode';
import {
  AgentSource,
  createPreviewSessionCache,
  type AgentPreviewMessage,
  type AgentPreviewStartResponse
} from '@salesforce/agents';
import { SfError, Connection, SfProject } from '@salesforce/core';
import { EOL } from 'os';
import { CoreExtensionService } from '../../../services/coreExtensionService';
import type { AgentViewState } from '../state/agentViewState';
import type { WebviewMessageSender } from '../handlers/webviewMessageSender';
import type { AgentInitializer } from '../agent/agentInitializer';
import type { HistoryManager } from '../history/historyManager';
import { Logger } from '../../../utils/logger';
import { createSessionStartGuards } from './sessionStartGuards';
import { SessionStartCancelledError } from '../types';
import { validatePublishedAgentId } from '../agent/agentUtils';

/**
 * Manages agent session lifecycle (start, end, restart)
 */
export class SessionManager {
  private readonly logger: Logger;

  constructor(
    private readonly state: AgentViewState,
    private readonly messageSender: WebviewMessageSender,
    private readonly agentInitializer: AgentInitializer,
    private readonly historyManager: HistoryManager
  ) {
    this.logger = new Logger(CoreExtensionService.getChannelService());
  }

  /**
   * Starts a preview session for an agent
   */
  async startSession(
    agentId: string,
    agentSource: AgentSource,
    isLiveMode?: boolean,
    webviewView?: vscode.WebviewView
  ): Promise<void> {
    if (!webviewView) {
      throw new Error('Webview is not ready. Please ensure the view is visible.');
    }

    const sessionStartId = this.state.beginSessionStart();
    const { ensureActive, isActive } = createSessionStartGuards(this.state, sessionStartId);

    try {
      await this.state.setSessionStarting(true);
      ensureActive();

      // Clear any previous error messages
      this.messageSender.sendClearMessages();
      this.messageSender.sendSessionStarting();

      // Reset planId when starting a new session
      this.state.currentPlanId = undefined;

      // Get connection and project
      const conn = await CoreExtensionService.getDefaultConnection();
      ensureActive();

      // Update currentAgentId
      this.state.currentAgentId = agentId;
      const project = SfProject.getInstance();

      this.state.pendingStartAgentId = agentId;
      this.state.pendingStartAgentSource = agentSource;

      // Initialize agent based on source
      if (agentSource === AgentSource.SCRIPT) {
        await this.initializeScriptAgent(agentId, conn, project, isLiveMode, isActive, ensureActive);
      } else {
        await this.initializePublishedAgent(agentId, conn, project, ensureActive);
      }

      if (!this.state.agentInstance) {
        throw new Error('Failed to initialize agent instance.');
      }

      // Start the session
      const session = await this.state.agentInstance.preview.start();
      ensureActive();
      this.state.sessionId = session.sessionId;
      this.state.sessionAgentId = agentId;
      this.logSessionStarted(isLiveMode);
      await this.writeSessionCache(agentSource, isLiveMode);

      // Load history
      await this.historyManager.loadAndSendTraceHistory(agentId, agentSource);
      await this.state.setSessionActive(true);
      ensureActive();
      await this.state.setSessionStarting(false);
      ensureActive();

      // Send session started message
      const agentMessage = session.messages.find((msg: AgentPreviewMessage) => msg.type === 'Inform');
      this.messageSender.sendSessionStarted(agentMessage?.message, this.state.sessionId);
      this.state.pendingStartAgentId = undefined;
      this.state.pendingStartAgentSource = undefined;
      await this.state.setConversationDataAvailable(true);
    } catch (err) {
      if (err instanceof SessionStartCancelledError || !isActive()) {
        return;
      }

      // Handle compilation errors
      if (
        this.state.currentAgentSource === AgentSource.SCRIPT &&
        err instanceof SfError &&
        err.message.includes('error compiling')
      ) {
        const sfError = err as SfError;
        const detailedError = this.logCompilationError(sfError);
        this.messageSender.sendCompilationError(detailedError);
        await this.state.setSessionStarting(false);
        await this.state.setResetAgentViewAvailable(true);
        await this.state.setSessionErrorState(true);
        return;
      }

      const sfError = SfError.wrap(err);
      this.logger.error('Error starting session', sfError);
      throw sfError;
    }
  }

  /**
   * Resumes a previously cached session by loading its state from disk.
   * Does NOT call preview.start() — keeps the same sessionId.
   */
  async resumeSession(
    agentId: string,
    agentSource: AgentSource,
    sessionId: string,
    isLiveMode?: boolean,
    webviewView?: vscode.WebviewView
  ): Promise<void> {
    if (!webviewView) {
      throw new Error('Webview is not ready. Please ensure the view is visible.');
    }

    const sessionStartId = this.state.beginSessionStart();
    const { ensureActive, isActive } = createSessionStartGuards(this.state, sessionStartId);

    try {
      // Single beat: sessionActive=false + sessionStarting=true, message cleared.
      // This avoids a flicker through the "no session" toolbar state.
      await this.beginRestart(this.state.isLiveMode ? 'Resuming live test...' : 'Resuming session...');
      ensureActive();

      // Tear down any prior SDK session in place. The agent instance is
      // discarded (replaced below) so the previous session can be safely ended.
      if (this.state.agentInstance && this.state.sessionId) {
        try {
          if (this.state.currentAgentSource === AgentSource.SCRIPT) {
            await this.state.agentInstance.preview.end();
          } else {
            await this.state.agentInstance.preview.end('UserRequest');
          }
        } catch (error) {
          console.warn('Error ending previous session before resume:', error);
        }
        try {
          await this.state.agentInstance.restoreConnection();
        } catch (error) {
          console.warn('Error restoring connection before resume:', error);
        }
        this.state.clearSessionState();
        ensureActive();
      }

      const conn = await CoreExtensionService.getDefaultConnection();
      ensureActive();

      this.state.currentAgentId = agentId;
      const project = SfProject.getInstance();

      this.state.pendingStartAgentId = agentId;
      this.state.pendingStartAgentSource = agentSource;

      if (agentSource === AgentSource.SCRIPT) {
        await this.initializeScriptAgent(agentId, conn, project, isLiveMode, isActive, ensureActive);
      } else {
        await this.initializePublishedAgent(agentId, conn, project, ensureActive);
      }

      if (!this.state.agentInstance) {
        throw new Error('Failed to initialize agent instance.');
      }

      await this.state.agentInstance.resumeSession(sessionId);
      ensureActive();
      this.state.sessionId = sessionId;
      this.state.sessionAgentId = agentId;
      this.logger.debug(`Resumed session for agent ${this.state.currentAgentName}. SessionId: ${sessionId}`);

      // Load conversation history first. The webview's conversationHistory
      // handler temporarily flips sessionActive=false; sessionStarted (sent
      // below) flips it back true so the input becomes editable.
      await this.historyManager.loadAndSendConversationHistory(agentId, agentSource);

      await this.state.setSessionActive(true);
      ensureActive();
      await this.state.setSessionStarting(false);
      ensureActive();

      // Send sessionStarted before traces so the tracer's reset-on-start
      // doesn't wipe the trace history we're about to send.
      this.messageSender.sendSessionStarted(undefined, this.state.sessionId, true);
      this.state.pendingStartAgentId = undefined;
      this.state.pendingStartAgentSource = undefined;

      await this.historyManager.loadAndSendTraceHistory(agentId, agentSource);

      await this.state.setConversationDataAvailable(true);
    } catch (err) {
      if (err instanceof SessionStartCancelledError || !isActive()) {
        return;
      }

      const sfError = SfError.wrap(err);
      this.logger.error('Error resuming session', sfError);
      await this.state.setSessionStarting(false);
      await this.messageSender.sendError(`Failed to resume session: ${sfError.message}`);
      await this.state.setResetAgentViewAvailable(true);
      await this.state.setSessionErrorState(true);
    }
  }

  /**
   * Ends the current agent session
   */
  async endSession(
    restoreViewCallback?: () => Promise<void>,
    options?: { restarting?: boolean }
  ): Promise<void> {
    this.state.cancelPendingSessionStart();
    const sessionWasStarting = this.state.isSessionStarting;

    // Optimistic update: immediately update VS Code context so view/title icons change
    // This matches the webview's optimistic update for button state
    await this.state.setSessionActive(false);
    await this.state.setSessionStarting(false);
    // Block toolbar actions while the SDK teardown is in flight. Without this,
    // the gap between sessionActive=false and clearSessionState exposes
    // toolbar items gated only on !sessionActive && !sessionStarting.
    await this.state.setSessionStopping(true);

    const agentName = this.state.currentAgentName;
    const sessionId = this.state.sessionId;
    // Capture identity before clearSessionState wipes it. After Stop, the
    // just-ended session becomes a previewable history-like session: Resume
    // and Clear appear on the toolbar, but the chat messages stay on screen.
    // We only mark it previewable, we don't reload the conversation.
    const endedAgentSource = this.state.currentAgentSource;
    const endedSessionType: 'simulated' | 'live' | 'published' | undefined = endedAgentSource
      ? endedAgentSource === AgentSource.SCRIPT
        ? this.state.isLiveMode
          ? 'live'
          : 'simulated'
        : 'published'
      : undefined;
    const hadRunningSession = !!(this.state.agentInstance && this.state.sessionId);

    if (this.state.agentInstance && this.state.sessionId) {
      // Restore connection before clearing agent references
      try {
        await this.state.agentInstance.restoreConnection();
      } catch (error) {
        console.warn('Error restoring connection:', error);
      }

      this.state.clearSessionState();
    }

    this.logger.debug(`Simulation ended. AgentName: ${agentName}, SessionId: ${sessionId}`);

    if (hadRunningSession && sessionId && endedSessionType && !options?.restarting) {
      // Mark the just-ended session as previewable so the hasLoadedSession
      // context flips on (showing the Clear toolbar action) and the webview
      // toolbar shows Resume. The chat is left untouched; the conversation
      // already on screen is the previewed session's transcript.
      // Skipped when this end is part of a restart (mode switch / agent
      // change): the upcoming startSession would route through resume,
      // which is not what the user asked for.
      this.state.previewedSessionId = sessionId;
      this.messageSender.sendSessionEnded({ sessionId, sessionType: endedSessionType });
    } else if (hadRunningSession || sessionWasStarting) {
      this.messageSender.sendSessionEnded();
    }

    if (sessionWasStarting && restoreViewCallback) {
      await restoreViewCallback();
    }

    await this.state.setSessionStopping(false);
  }

  /**
   * Restarts the agent session without recompilation
   */
  async restartSession(): Promise<void> {
    if (!this.state.agentInstance || !this.state.sessionId || !this.state.currentAgentSource) {
      return;
    }

    try {
      const message = this.state.isLiveMode ? 'Restarting live test...' : 'Restarting...';
      await this.beginRestart(message);

      // Start a new session directly - the SDK handles ending the previous session internally
      const session = await this.state.agentInstance.preview.start();
      this.state.sessionId = session.sessionId;
      await this.writeSessionCache(this.state.currentAgentSource, this.state.isLiveMode);

      await this.completeRestart(session, 'Agent session restarted.');
    } catch (error) {
      await this.handleRestartError(error, 'restart');
    }
  }

  /**
   * Recompiles and restarts the agent session (full restart with compilation)
   */
  async recompileAndRestartSession(): Promise<void> {
    const agentId = this.state.currentAgentId;
    const agentSource = this.state.currentAgentSource;
    const isLiveMode = this.state.isLiveMode;

    if (!agentId || !agentSource) {
      return;
    }

    const sessionStartId = this.state.beginSessionStart();
    const { ensureActive, isActive } = createSessionStartGuards(this.state, sessionStartId);

    try {
      await this.beginRestart('Recompiling and restarting...');

      // End current session and clear agent instance (to trigger recompilation)
      if (this.state.agentInstance && this.state.sessionId) {
        const isAgentSimulate = agentSource === AgentSource.SCRIPT;
        if (isAgentSimulate) {
          await this.state.agentInstance.preview.end();
        } else {
          await this.state.agentInstance.preview.end('UserRequest');
        }

        try {
          await this.state.agentInstance.restoreConnection();
        } catch (error) {
          console.warn('Error restoring connection:', error);
        }
      }

      // Clear session state including agent instance (forces recompilation)
      this.state.clearSessionState();
      ensureActive();

      // Get connection and project for re-initialization
      const conn = await CoreExtensionService.getDefaultConnection();
      ensureActive();

      this.state.currentAgentId = agentId;
      const project = SfProject.getInstance();

      this.state.pendingStartAgentId = agentId;
      this.state.pendingStartAgentSource = agentSource;

      // Re-initialize agent (this triggers compilation for script agents)
      if (agentSource === AgentSource.SCRIPT) {
        await this.initializeScriptAgent(agentId, conn, project, isLiveMode, isActive, ensureActive);
      } else {
        await this.initializePublishedAgent(agentId, conn, project, ensureActive);
      }

      if (!this.state.agentInstance) {
        throw new Error('Failed to initialize agent instance.');
      }

      // Start the session
      const session = await this.state.agentInstance.preview.start();
      ensureActive();
      this.state.sessionId = session.sessionId;
      this.state.sessionAgentId = agentId;
      this.logSessionStarted(isLiveMode);
      await this.writeSessionCache(agentSource, isLiveMode);
      await this.completeRestart(session, 'Agent session recompiled and restarted.', ensureActive);
      this.state.pendingStartAgentId = undefined;
      this.state.pendingStartAgentSource = undefined;
    } catch (error) {
      if (error instanceof SessionStartCancelledError || !isActive()) {
        return;
      }

      // Handle compilation errors specifically
      if (
        this.state.currentAgentSource === AgentSource.SCRIPT &&
        error instanceof SfError &&
        error.message.includes('Failed to compile agent script')
      ) {
        const sfError = error as SfError;
        const detailedError = this.logCompilationError(sfError);
        this.messageSender.sendCompilationError(detailedError);
        await this.state.setSessionStarting(false);
        await this.state.setResetAgentViewAvailable(true);
        await this.state.setSessionErrorState(true);
        return;
      }

      await this.handleRestartError(error, 'recompile and restart');
    }
  }

  /**
   * Common setup for restart operations - immediate UI feedback
   */
  private async beginRestart(message: string): Promise<void> {
    await this.state.setSessionActive(false);
    await this.state.setSessionStarting(true);
    this.messageSender.sendClearMessages();
    this.messageSender.sendSessionStarting(message);

    // Clear conversation state
    this.state.currentPlanId = undefined;
    this.state.currentUserMessage = undefined;
    await this.state.setConversationDataAvailable(false);
  }

  /**
   * Common completion for restart operations
   */
  private async completeRestart(
    session: AgentPreviewStartResponse,
    logMessage: string,
    ensureActive?: () => void
  ): Promise<void> {
    if (this.state.currentAgentId && this.state.currentAgentSource) {
      await this.historyManager.loadAndSendTraceHistory(this.state.currentAgentId, this.state.currentAgentSource);
    }

    await this.state.setSessionActive(true);
    ensureActive?.();
    await this.state.setSessionStarting(false);
    ensureActive?.();

    const agentMessage = session.messages.find((msg: AgentPreviewMessage) => msg.type === 'Inform');
    this.messageSender.sendSessionStarted(agentMessage?.message, this.state.sessionId);
    await this.state.setConversationDataAvailable(true);

    this.logger.debug(logMessage);
  }

  /**
   * Logs session start information with agent details
   */
  private logSessionStarted(isLiveMode: boolean | undefined): void {
    const isLive = isLiveMode ?? false;
    this.logger.debug(
      (isLive ? 'Live test session started' : 'Simulation session started') +
        ` for agent ${this.state.currentAgentName}. SessionId: ${this.state.sessionId}`
    );
  }

  /**
   * Logs compilation error details for script agents
   */
  private logCompilationError(sfError: SfError): string {
    this.logger.error('Failed to compile agent script', sfError);
    this.logger.errorDetail(sfError.name);
    return `Failed to compile agent script${EOL}${sfError.name}`;
  }

  /**
   * Common error handling for restart operations
   */
  private async handleRestartError(error: unknown, action: string): Promise<void> {
    await this.state.setSessionActive(false);
    await this.state.setSessionStarting(false);

    const errorMessage = error instanceof Error ? error.message : String(error);
    this.logger.debug(`Failed to ${action} session: ${errorMessage}`);

    await this.messageSender.sendError(`Failed to ${action}: ${errorMessage}`);
    await this.state.setResetAgentViewAvailable(true);
    await this.state.setSessionErrorState(true);
  }

  /**
   * Initializes a script agent
   */
  private async initializeScriptAgent(
    agentId: string,
    conn: Connection,
    project: SfProject,
    isLiveMode: boolean | undefined,
    isActive: () => boolean,
    ensureActive: () => void
  ): Promise<void> {
    const filePath = agentId;
    if (!filePath) {
      throw new Error('No file path found for script agent.');
    }

    const determinedLiveMode = isLiveMode ?? false;
    await this.state.setLiveMode(determinedLiveMode);
    ensureActive();

    // Initialize agent with lifecycle listeners
    await this.agentInitializer.initializeScriptAgent(
      filePath,
      conn,
      project,
      determinedLiveMode,
      isActive,
      (data: { message?: string; error?: string }) => {
        if (data.error) {
          this.messageSender.sendCompilationError(data.error);
        } else {
          this.logger.debug('Compilation endpoint called');
          this.messageSender.sendCompilationStarting(data.message);
        }
      },
      (data: { message?: string }) => {
        const modeMessage = determinedLiveMode ? 'Starting live test...' : 'Starting simulation...';
        this.messageSender.sendSimulationStarting(data.message || modeMessage);
      }
    );

    this.state.currentAgentName = this.state.agentInstance?.name;
    this.state.currentAgentId = agentId;

    // Enable debug mode if set
    if (this.state.isApexDebuggingEnabled && this.state.agentInstance) {
      this.state.agentInstance.preview.setApexDebugging(this.state.isApexDebuggingEnabled);
    }
  }

  private async writeSessionCache(agentSource: AgentSource, isLiveMode: boolean | undefined): Promise<void> {
    const sessionType: 'live' | 'simulated' | 'published' =
      agentSource === AgentSource.SCRIPT ? (isLiveMode ? 'live' : 'simulated') : 'published';
    try {
      await createPreviewSessionCache(this.state.agentInstance!, {
        displayName: this.state.currentAgentName,
        sessionType
      });
    } catch (err) {
      this.logger.warn(`Failed to write preview session cache: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Initializes a published agent
   */
  private async initializePublishedAgent(
    agentId: string,
    conn: Connection,
    project: SfProject,
    ensureActive: () => void
  ): Promise<void> {
    // Validate agent ID format - only validate if it looks like a Bot ID
    // This prevents errors when a script agent name is incorrectly passed here
    if (agentId.startsWith('0X') && (agentId.length === 15 || agentId.length === 18)) {
      validatePublishedAgentId(agentId);
    } else {
      // If it doesn't look like a Bot ID, this is likely a misrouted script agent
      // Throw a more helpful error
      throw new Error(
        `Invalid agent ID for published agent. Expected a Bot ID (starting with "0X"), but got: ${agentId}. This may be a script agent.`
      );
    }

    // Published agents are always in live mode
    await this.state.setLiveMode(true);
    ensureActive();

    // Initialize agent
    await this.agentInitializer.initializePublishedAgent(agentId, conn, project);

    this.state.currentAgentName = this.state.agentInstance?.name;
    this.state.currentAgentId = agentId;

    // Enable debug mode if set
    if (this.state.isApexDebuggingEnabled && this.state.agentInstance) {
      this.state.agentInstance.preview.setApexDebugging(this.state.isApexDebuggingEnabled);
    }
  }
}
