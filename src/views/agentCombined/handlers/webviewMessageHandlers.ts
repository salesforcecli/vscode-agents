import * as vscode from 'vscode';
import { AgentSource, Agent } from '@salesforce/agents';
import { SfProject, SfError } from '@salesforce/core';
import { CoreExtensionService } from '../../../services/coreExtensionService';
import type { TraceHistoryEntry } from '../../../utils/traceHistory';
import type { AgentMessage } from '../types';
import type { AgentViewState } from '../state';
import type { WebviewMessageSender } from './webviewMessageSender';
import type { SessionManager } from '../session';
import type { HistoryManager } from '../history';
import type { ApexDebugManager } from '../debugging';
import { Logger } from '../../../utils/logger';
import { getAgentSource } from '../agent';
import { listSessionsForAgent } from '../session';

/**
 * Handles all incoming messages from the webview
 */
export class WebviewMessageHandlers {
  private readonly logger: Logger;

  constructor(
    private readonly state: AgentViewState,
    private readonly messageSender: WebviewMessageSender,
    private readonly sessionManager: SessionManager,
    private readonly historyManager: HistoryManager,
    private readonly apexDebugManager: ApexDebugManager,
    private readonly context: vscode.ExtensionContext,
    private readonly webviewView: vscode.WebviewView
  ) {
    this.logger = new Logger(CoreExtensionService.getChannelService());
  }

  /**
   * Routes webview messages to the appropriate handler method
   */
  async handleMessage(message: AgentMessage): Promise<void> {
    const command = message.command || message.type;
    if (!command) {
      console.warn('Received message without command or type:', message);
      return;
    }

    const commandHandlers: Record<string, (message: AgentMessage) => Promise<void>> = {
      startSession: async msg => await this.handleStartSession(msg),
      setApexDebugging: async msg => await this.handleSetApexDebugging(msg),
      sendChatMessage: async msg => await this.handleSendChatMessage(msg),
      endSession: async msg => await this.handleEndSession(msg),
      loadAgentHistory: async msg => await this.handleLoadAgentHistory(msg),
      getAvailableAgents: async () => await this.handleGetAvailableAgents(),
      getTraceData: async () => await this.handleGetTraceData(),
      openTraceJson: async msg => await this.handleOpenTraceJson(msg),
      getConfiguration: async msg => await this.handleGetConfiguration(msg),
      executeCommand: async msg => await this.handleExecuteCommand(msg),
      openUrl: async msg => await this.handleOpenUrl(msg),
      setSelectedAgentId: async msg => await this.handleSetSelectedAgentId(msg),
      setLiveMode: async msg => await this.handleSetLiveMode(msg),
      getInitialLiveMode: async () => await this.handleGetInitialLiveMode(),
      listSessions: async msg => await this.handleListSessions(msg),
      previewSession: async msg => await this.handlePreviewSession(msg),
      clearPreviewedSession: async () => await this.handleClearPreviewedSession(),
      // Test-specific commands for integration tests
      clearMessages: async () => {
        // Clear messages in the webview - no-op on extension side
        this.messageSender.sendClearMessages();
      },
      testTraceDataReceived: async () => {
        // Test command - no-op
      },
      testTraceHistoryReceived: async () => {
        // Test command - no-op
      }
    };

    const handler = commandHandlers[command];
    if (handler) {
      await handler(message);
    } else {
      console.warn(`Unknown webview command: ${command}`);
    }
  }

  /**
   * Handles errors from webview message processing
   */
  async handleError(err: unknown): Promise<void> {
    console.error('AgentCombinedViewProvider Error:', err);
    const sfError = SfError.wrap(err);
    const originalErrorMessage = sfError.message;
    this.logger.error('AgentCombinedViewProvider error', sfError);

    this.state.pendingStartAgentId = undefined;
    this.state.pendingStartAgentSource = undefined;

    if (this.state.agentInstance || this.state.isSessionActive) {
      this.state.clearSessionState();
      await this.state.setSessionActive(false);
    }
    await this.state.setSessionStarting(false);

    if (
      originalErrorMessage.includes('404') &&
      originalErrorMessage.includes('NOT_FOUND') &&
      originalErrorMessage.includes('No valid version available')
    ) {
      await this.messageSender.sendError(
        'Agent deactivated',
        'This agent is currently deactivated, so you can\'t converse with it. Activate it using the "AFDX: Activate Agent" command or your org\'s Agentforce UI.'
      );
    } else if (originalErrorMessage.includes('NOT_FOUND') && originalErrorMessage.includes('404')) {
      await this.messageSender.sendError(
        'Agent not found',
        "The selected agent couldn't be found. Either it's been deleted or you don't have access to it."
      );
    } else if (originalErrorMessage.includes('403') || originalErrorMessage.includes('FORBIDDEN')) {
      await this.messageSender.sendError(
        'Permission denied',
        "You don't have permission to use this agent. Consult your Salesforce administrator."
      );
    } else {
      await this.messageSender.sendError('Something went wrong', originalErrorMessage);
    }

    await this.state.setResetAgentViewAvailable(true);
    await this.state.setSessionErrorState(true);
  }

  private async handleStartSession(message: AgentMessage): Promise<void> {
    const data = message.data as { agentId?: string; isLiveMode?: boolean; agentSource?: AgentSource } | undefined;
    const agentId = data?.agentId || this.state.currentAgentId;

    if (!agentId || typeof agentId !== 'string') {
      throw new Error(`Invalid agent ID: ${agentId}. Expected a string.`);
    }

    // Determine agent source - prefer passed value, then state, then fetch
    let agentSource = data?.agentSource ?? this.state.currentAgentSource;
    if (!agentSource) {
      agentSource = await getAgentSource(agentId);
    }
    this.state.currentAgentSource = agentSource;

    const isLiveMode = data?.isLiveMode ?? false;

    // If a session is currently being previewed via the History tab, the Start
    // button should resume that session rather than create a new one.
    const previewedSessionId = this.state.previewedSessionId;
    if (previewedSessionId && agentId === this.state.currentAgentId) {
      this.state.previewedSessionId = undefined;
      await this.sessionManager.resumeSession(agentId, agentSource, previewedSessionId, isLiveMode, this.webviewView);
      return;
    }

    await this.sessionManager.startSession(agentId, agentSource, isLiveMode, this.webviewView);
  }

  private async handleSetApexDebugging(message: AgentMessage): Promise<void> {
    const enabled = message.data as boolean | undefined;
    await this.state.setDebugMode(enabled ?? false);
    if (this.state.agentInstance) {
      this.state.agentInstance.preview.setApexDebugging(this.state.isApexDebuggingEnabled);
    }
  }

  private async handleSendChatMessage(message: AgentMessage): Promise<void> {
    if (!this.state.agentInstance || !this.state.sessionId) {
      throw new Error('Session has not been started.');
    }

    this.messageSender.sendMessageStarting();

    const data = message.data as { message?: string } | undefined;
    const userMessage = data?.message;
    if (!userMessage || typeof userMessage !== 'string') {
      throw new Error('Invalid message: expected a string.');
    }

    this.logger.debug(
      `Sending message to agent preview. AgentName: ${this.state.currentAgentName}, SessionId: ${this.state.sessionId}`
    );

    const response = await this.state.agentInstance.preview.send(userMessage);

    const lastMessage = response.messages?.at(-1);
    this.state.currentPlanId = lastMessage?.planId;
    this.state.currentUserMessage = userMessage;

    this.messageSender.sendMessageSent(lastMessage?.message);
    this.logger.debug(
      `Received response from agent preview. AgentName: ${this.state.currentAgentName}, SessionId: ${this.state.sessionId}, PlanId: ${this.state.currentPlanId}`
    );

    // Load and send trace data after sending message
    if (this.state.currentAgentId && this.state.currentAgentSource) {
      const loadTraceWithRetry = async (retries = 5, delay = 200) => {
        for (let i = 0; i < retries; i++) {
          try {
            // Use agent instance method to get history
            if (this.state.agentInstance && this.state.sessionId) {
              await this.historyManager.loadAndSendTraceHistory(
                this.state.currentAgentId!,
                this.state.currentAgentSource!
              );
              return;
            }

            if (i < retries - 1) {
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          } catch (err) {
            console.error(`Error loading trace after message (attempt ${i + 1}):`, err);
            if (i < retries - 1) {
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }
        }
      };

      loadTraceWithRetry().catch(err => {
        console.error('Error in trace loading retry:', err);
      });
    }

    // Handle Apex debug log
    if (this.state.isApexDebuggingEnabled && response.apexDebugLog) {
      await this.apexDebugManager.handleApexDebugLog(response.apexDebugLog, this.context);
    } else if (this.state.isApexDebuggingEnabled && !response.apexDebugLog) {
      vscode.window.showInformationMessage('Debug mode is enabled but no Apex was executed.');
    }
  }

  private async handleEndSession(message?: AgentMessage): Promise<void> {
    const data = message?.data as { restarting?: boolean } | undefined;
    await this.sessionManager.endSession(
      async () => {
        const agentId = this.state.pendingStartAgentId ?? this.state.currentAgentId;
        if (agentId) {
          const agentSource = this.state.pendingStartAgentSource ?? (await getAgentSource(agentId));
          await this.historyManager.showHistoryOrPlaceholder(agentId, agentSource);
        }
      },
      { restarting: data?.restarting === true }
    );
  }

  private async handleLoadAgentHistory(message: AgentMessage): Promise<void> {
    const data = message.data as { agentId?: string; agentSource?: AgentSource } | undefined;
    const agentId = data?.agentId;
    if (agentId && typeof agentId === 'string') {
      // Use passed agentSource if available to avoid expensive listPreviewable call
      const agentSource = data?.agentSource ?? (await getAgentSource(agentId));
      await this.historyManager.showHistoryOrPlaceholder(agentId, agentSource);
    }
  }

  private async handleGetAvailableAgents(): Promise<void> {
    let instanceUrl: string | undefined;
    try {
      const conn = await CoreExtensionService.getDefaultConnection();
      instanceUrl = conn.instanceUrl;
      const project = SfProject.getInstance();
      const allAgents = await Agent.listPreviewable(conn, project);

      // Map agents - script agents use aabName as id, published agents use id
      const mappedAgents = allAgents
        .filter(agent => agent.id || agent.aabName) // Must have either id (published) or aabName (script)
        .map(agent => {
          const agentId = agent.id || agent.aabName;
          if (!agentId) {
            throw new Error(`Agent ${agent.name} is missing both id and aabName`);
          }
          return {
            name: (agent.developerName ?? agent.aabName) as string,
            id: agentId,
            type: agent.source
          };
        });

      // Fetch versions for all published agents in parallel and cache them
      const publishedAgents = mappedAgents.filter(a => a.type === AgentSource.PUBLISHED);
      const versionMap = new Map<string, number>();
      this.state.agentVersionsCache.clear();
      if (publishedAgents.length > 0) {
        const versionResults = await Promise.allSettled(
          publishedAgents.map(async a => {
            const agent = await Agent.init({ connection: conn, project, apiNameOrId: a.id });
            const meta = await agent.getBotMetadata();
            const versions = meta.BotVersions.records
              .filter((v: { IsDeleted?: boolean }) => !v.IsDeleted)
              .map((v: { VersionNumber: number; Status: string }) => ({
                VersionNumber: v.VersionNumber,
                Status: v.Status
              }));
            const active = versions.find((v: { Status: string }) => v.Status === 'Active');
            return { id: a.id, versions, activeVersion: active?.VersionNumber as number | undefined };
          })
        );
        for (const result of versionResults) {
          if (result.status === 'fulfilled') {
            this.state.agentVersionsCache.set(result.value.id, result.value.versions);
            if (result.value.activeVersion !== undefined) {
              versionMap.set(result.value.id, result.value.activeVersion);
            }
          }
        }
      }

      const agentsWithVersions = mappedAgents.map(a => ({
        ...a,
        activeVersion: versionMap.get(a.id)
      }));

      // Use pendingSelectAgentId if available (e.g., after creating a new agent), otherwise currentAgentId
      const selectAgentId = this.state.pendingSelectAgentId || this.state.currentAgentId;
      this.messageSender.sendAvailableAgents(agentsWithVersions, selectAgentId);

      // Update context for command visibility
      await this.state.setAuthError(false);
      await this.state.setHasAgents(mappedAgents.length > 0);

      // Clear the pending/current agent IDs after use
      this.state.pendingSelectAgentId = undefined;
      if (this.state.currentAgentId) {
        this.state.currentAgentId = undefined;
      }
    } catch (err) {
      console.error('Error getting available agents from org:', err);
      this.state.pendingSelectAgentId = undefined;

      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorName = err instanceof Error ? err.name : '';
      const fullError = `${errorName}: ${errorMessage}`;

      const isAuthError =
        errorName === 'RefreshTokenAuthError' ||
        fullError.includes('RefreshTokenAuthError') ||
        fullError.includes('authentication failure') ||
        fullError.includes('expired') ||
        fullError.includes('INVALID_CROSS_REFERENCE_KEY') ||
        fullError.includes('invalid cross reference id') ||
        fullError.includes('INVALID_SESSION_ID') ||
        fullError.includes('No default org configured');

      const isFeatureNotEnabled =
        fullError.includes('INVALID_TYPE') && fullError.includes('BotDefinition');

      if (isFeatureNotEnabled) {
        const setupUrl = instanceUrl
          ? `${instanceUrl}/lightning/setup/EinsteinCopilot/home`
          : undefined;
        this.messageSender.sendAuthError(
          'Agentforce is not enabled',
          'This org does not have Agentforce enabled. Select an org with Agentforce to continue.',
          setupUrl
        );
        await this.state.setAuthError(true);
      } else if (isAuthError) {
        this.messageSender.sendAuthError(
          'Unable to connect to org',
          'Set a new default org or re-authenticate to continue.'
        );
        await this.state.setAuthError(true);
      } else {
        this.messageSender.sendAvailableAgents([], undefined);
      }
      await this.state.setHasAgents(false);
    }
  }

  private async handleGetTraceData(): Promise<void> {
    try {
      if (this.state.currentAgentId && this.state.currentAgentSource) {
        // When the user is previewing a specific historical session, load
        // traces for that session (not falling back to "most recent"). Use
        // the trace-only path so we don't re-render the chat.
        if (this.state.previewedSessionId && !this.state.isSessionActive) {
          await this.historyManager.loadAndSendTracesForSession(
            this.state.currentAgentId,
            this.state.currentAgentSource,
            this.state.previewedSessionId
          );
          return;
        }
        await this.historyManager.loadAndSendTraceHistory(this.state.currentAgentId, this.state.currentAgentSource);
        return;
      }

      // If no agent is selected, send empty trace data
      const emptyTraceData = { plan: [], planId: '', sessionId: '' };
      this.messageSender.sendTraceData(emptyTraceData);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.messageSender.sendError(errorMessage);
    }
  }

  private async handleOpenTraceJson(message: AgentMessage): Promise<void> {
    const data = message.data as { entry?: TraceHistoryEntry } | undefined;
    await this.historyManager.openTraceJsonEntry(data?.entry);
  }

  private async handleGetConfiguration(message: AgentMessage): Promise<void> {
    const config = vscode.workspace.getConfiguration();
    const data = message.data as { section?: string } | undefined;
    const section = data?.section;
    if (section) {
      const value = config.get(section);
      this.messageSender.sendConfiguration(section, value);
    }
  }

  private async handleExecuteCommand(message: AgentMessage): Promise<void> {
    const data = message.data as { commandId?: string; args?: unknown[] } | undefined;
    const commandId = data?.commandId;
    if (commandId && typeof commandId === 'string') {
      const args = Array.isArray(data?.args) ? data.args : [];
      await vscode.commands.executeCommand(commandId, ...args);
    }
  }

  private async handleOpenUrl(message: AgentMessage): Promise<void> {
    const data = message.data as { url?: string } | undefined;
    const url = data?.url;
    if (url && typeof url === 'string') {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }

  private async handleSetSelectedAgentId(message: AgentMessage): Promise<void> {
    const data = message.data as { agentId?: string; agentSource?: AgentSource } | undefined;
    const agentId = data?.agentId;
    if (agentId !== this.state.currentAgentId) {
      this.state.previewedSessionId = undefined;
    }
    if (agentId && typeof agentId === 'string' && agentId !== '') {
      this.state.currentAgentId = agentId;
      // Use passed agentSource if available to avoid expensive listPreviewable call
      this.state.currentAgentSource = data?.agentSource ?? (await getAgentSource(agentId));
      await this.state.setAgentSelected(true);
      await this.state.setResetAgentViewAvailable(false);
      await this.state.setSessionErrorState(false);
      // Load history atomically with agent selection to avoid download button delay
      await this.historyManager.showHistoryOrPlaceholder(agentId, this.state.currentAgentSource);
    } else {
      this.state.currentAgentId = undefined;
      this.state.currentAgentSource = undefined;
      this.state.currentAgentActiveVersion = undefined;
      await this.state.setAgentSelected(false);
      await this.state.setConversationDataAvailable(false);
    }
  }

  private async handleSetLiveMode(message: AgentMessage): Promise<void> {
    const data = message.data as { isLiveMode?: boolean } | undefined;
    const isLiveMode = data?.isLiveMode;
    if (typeof isLiveMode === 'boolean') {
      await this.state.setLiveMode(isLiveMode);
    }
  }

  private async handleGetInitialLiveMode(): Promise<void> {
    this.messageSender.sendLiveMode(this.state.isLiveMode);
  }

  private async handleListSessions(message: AgentMessage): Promise<void> {
    const data = message.data as { agentId?: string; agentSource?: AgentSource } | undefined;
    const agentId = data?.agentId ?? this.state.currentAgentId;
    if (!agentId || typeof agentId !== 'string') {
      this.messageSender.sendSessionList('', []);
      return;
    }
    try {
      const agentSource = data?.agentSource ?? this.state.currentAgentSource ?? (await getAgentSource(agentId));
      const sessions = await listSessionsForAgent(agentId, agentSource);
      this.messageSender.sendSessionList(agentId, sessions);
    } catch (err) {
      console.error('Error listing sessions:', err);
      this.messageSender.sendSessionList(agentId, []);
    }
  }

  /**
   * Loads a prior session's transcript + traces into the views without starting it.
   * Records previewedSessionId so the next "start" click resumes this session
   * instead of creating a new one.
   */
  private async handlePreviewSession(message: AgentMessage): Promise<void> {
    const data = message.data as
      | { agentId?: string; agentSource?: AgentSource; sessionId?: string; sessionType?: 'simulated' | 'live' | 'published' }
      | undefined;
    const agentId = data?.agentId ?? this.state.currentAgentId;
    const sessionId = data?.sessionId;

    if (!agentId || typeof agentId !== 'string') {
      throw new Error(`Invalid agent ID: ${agentId}. Expected a string.`);
    }
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error(`Invalid session ID: ${sessionId}. Expected a string.`);
    }

    // No-op if this session is already the active live session.
    if (
      this.state.isSessionActive &&
      this.state.sessionId === sessionId &&
      this.state.sessionAgentId === agentId
    ) {
      return;
    }

    let agentSource = data?.agentSource ?? this.state.currentAgentSource;
    if (!agentSource) {
      agentSource = await getAgentSource(agentId);
    }

    // Capture prior session identity BEFORE overwriting currentAgentSource.
    // Without this, previousSource reads the new source and the wrong
    // preview.end() argument is used to tear down the running session when
    // the previewed session has a different source than the running one.
    const previousAgent = this.state.agentInstance;
    const previousSessionId = this.state.sessionId;
    const previousSource = this.state.currentAgentSource;
    const hadActiveSession = !!(previousAgent && previousSessionId);

    this.state.currentAgentSource = agentSource;
    this.state.currentAgentId = agentId;

    // If a session is active, fully end it before showing the previewed
    // conversation. We surface a loading state via sessionStarting so the input
    // is disabled while the SDK round-trip completes (a few seconds for
    // live/published sessions).
    if (hadActiveSession) {
      this.state.cancelPendingSessionStart();
      // Flip context flags immediately so toolbar actions tied to sessionActive
      // (debug, stop, etc.) hide right away during the stopping transition.
      // The SDK round-trip below can take seconds and we don't want stale
      // session-active toolbar buttons hanging around.
      await this.state.setSessionActive(false);
      await this.state.setSessionStarting(true);
      await this.state.setSessionStopping(true);
      // Send sessionStarting FIRST so the webview's isSessionStartingRef flips
      // to true before the empty setConversation arrives — App.tsx uses that
      // ref to distinguish a stopping-transition clear (preserve Resume label)
      // from a toolbar Clear action (drop preview flag).
      this.messageSender.sendSessionStarting('Stopping session...');
      this.messageSender.sendSetConversation([], true, null);
      this.messageSender.sendTraceHistory(agentId, []);
      try {
        if (previousSource === AgentSource.SCRIPT) {
          await previousAgent!.preview.end();
        } else {
          await previousAgent!.preview.end('UserRequest');
        }
      } catch (err) {
        console.warn('Error ending previous session before preview:', err);
      }
      try {
        await previousAgent!.restoreConnection();
      } catch (err) {
        console.warn('Error restoring connection:', err);
      }
      this.state.clearSessionState();
      // We deliberately keep isSessionStarting=true through the disk read below
      // so the input stays disabled. Cleared after the preview is loaded.

      // Re-establish current agent context cleared by clearSessionState so the
      // previewed conversation is associated correctly.
      this.state.currentAgentId = agentId;
      this.state.currentAgentSource = agentSource;
    } else if (this.state.isSessionStarting) {
      // Cancel any in-flight start that hasn't produced an agent instance yet.
      await this.sessionManager.endSession();
    }

    this.state.previewedSessionId = sessionId;

    // Read the previewed session from disk and push it to the webview. The
    // setConversation message includes previewSessionInfo so the start button
    // flips to "Resume".
    await this.historyManager.loadAndSendSessionPreview(agentId, agentSource, sessionId, data?.sessionType);

    if (hadActiveSession) {
      // Now that the previewed conversation is on screen, clear the
      // starting/active state and emit sessionEnded so the input becomes
      // editable and the start button shows "Resume".
      await this.state.setSessionStarting(false);
      await this.state.setSessionStopping(false);
      this.messageSender.sendSessionEnded();
    }
  }

  /**
   * Drops the currently displayed conversation/traces so the user can start a
   * fresh session from an empty chat. Does not touch on-disk session data.
   */
  private async handleClearPreviewedSession(): Promise<void> {
    this.state.previewedSessionId = undefined;
    this.state.currentPlanId = undefined;
    await this.state.setConversationDataAvailable(false);
    this.messageSender.sendSetConversation([], true, null);
    if (this.state.currentAgentId) {
      this.messageSender.sendTraceHistory(this.state.currentAgentId, []);
    }
    this.messageSender.sendTraceData({ plan: [], planId: '', sessionId: '' });
  }

  async fetchAndSendActiveVersion(agentId: string): Promise<void> {
    const conn = await CoreExtensionService.getDefaultConnection();
    const project = SfProject.getInstance();
    const agent = await Agent.init({ connection: conn, project, apiNameOrId: agentId });
    const botMetadata = await agent.getBotMetadata();
    const activeRecord = botMetadata.BotVersions.records.find(
      (v: { Status: string; IsDeleted?: boolean }) => v.Status === 'Active' && !v.IsDeleted
    );
    const activeVersion = activeRecord?.VersionNumber as number | undefined;
    this.state.currentAgentActiveVersion = activeVersion;
    this.messageSender.sendAgentVersionInfo(agentId, activeVersion);
  }
}
