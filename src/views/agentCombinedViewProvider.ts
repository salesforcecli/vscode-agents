import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AgentSource, Agent, PreviewableAgent } from '@salesforce/agents';
import { getAllHistory, getHistoryDir } from '@salesforce/agents/lib/utils';
import { SfProject } from '@salesforce/core';
import { CoreExtensionService } from '../services/coreExtensionService';
import { AgentViewState } from './agentCombined/state';
import { WebviewMessageSender, WebviewMessageHandlers } from './agentCombined/handlers';
import { SessionManager } from './agentCombined/session';
import { AgentInitializer, getAgentStorageKey, getAgentSource } from './agentCombined/agent';
import { HistoryManager } from './agentCombined/history';
import { ApexDebugManager } from './agentCombined/debugging';
import { getJsonTokenColors } from '../utils/themeColors';
import { buildVersionPickerItems } from '../commands/activateAgent';

/**
 * Main orchestrator for the Agent Combined View Provider
 * Delegates to focused modules for specific functionality
 */
export class AgentCombinedViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sf.agent.combined.view';
  public webviewView?: vscode.WebviewView;
  private static instance: AgentCombinedViewProvider;

  // Core managers
  private readonly state: AgentViewState;
  private readonly messageSender: WebviewMessageSender;
  private readonly sessionManager: SessionManager;
  private readonly historyManager: HistoryManager;
  private readonly apexDebugManager: ApexDebugManager;
  private readonly agentInitializer: AgentInitializer;
  private messageHandlers?: WebviewMessageHandlers;

  constructor(private readonly context: vscode.ExtensionContext) {
    AgentCombinedViewProvider.instance = this;

    // Initialize state
    this.state = new AgentViewState(context);

    // Initialize message sender
    this.messageSender = new WebviewMessageSender(this.state);

    // Initialize managers
    this.agentInitializer = new AgentInitializer(this.state);
    this.historyManager = new HistoryManager(this.state, this.messageSender);
    this.apexDebugManager = new ApexDebugManager(this.messageSender);

    // Initialize session manager (depends on other managers)
    this.sessionManager = new SessionManager(
      this.state,
      this.messageSender,
      this.agentInitializer,
      this.historyManager
    );

    // Initialize context states
    void this.state.setResetAgentViewAvailable(false);
    void this.state.setSessionErrorState(false);
    void this.state.setConversationDataAvailable(false);
  }

  public static getInstance(): AgentCombinedViewProvider {
    return AgentCombinedViewProvider.instance;
  }

  /**
   * Main entry point - sets up webview and message handling
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.webviewView = webviewView;
    this.messageSender.setWebview(webviewView);

    // Configure webview
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'dist')]
    };

    // Set up message handlers
    this.messageHandlers = new WebviewMessageHandlers(
      this.state,
      this.messageSender,
      this.sessionManager,
      this.historyManager,
      this.apexDebugManager,
      this.context,
      webviewView
    );

    // Main entry point - clean and simple
    this.handleEventsFromWebview();

    // Set HTML content
    webviewView.webview.html = this.getHtmlForWebview();

    // Send editor theme token colors for syntax highlighting
    this.sendThemeColors();
    if (vscode.window.onDidChangeActiveColorTheme) {
      this.context.subscriptions.push(
        vscode.window.onDidChangeActiveColorTheme(() => {
          // Small delay to ensure workbench.colorTheme config reflects the new theme
          setTimeout(() => this.sendThemeColors(), 100);
        })
      );
    }
  }

  private sendThemeColors(): void {
    this.messageSender.sendThemeTokenColors(getJsonTokenColors());
  }

  /**
   * Sets up event handling from webview
   */
  private handleEventsFromWebview(): void {
    if (!this.webviewView || !this.messageHandlers) {
      return;
    }

    this.webviewView.webview.onDidReceiveMessage(async message => {
      try {
        await this.messageHandlers!.handleMessage(message);
      } catch (err) {
        try {
          await this.messageHandlers!.handleError(err);
        } catch (handlerErr) {
          // If even error handling fails, log it to prevent silent failures
          console.error('Critical error in message handling:', handlerErr);
        }
      }
    });
  }

  /**
   * Generates HTML for the webview
   */
  private getHtmlForWebview(): string {
    const htmlPath = path.join(this.context.extensionPath, 'webview', 'dist', 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    const vscodeScript = `
      <script>
        const vscode = acquireVsCodeApi();
        window.vscode = vscode;
        window.AgentSource = ${JSON.stringify({
          SCRIPT: AgentSource.SCRIPT,
          PUBLISHED: AgentSource.PUBLISHED
        })};
      </script>
    `;

    html = html.replace('</head>', `${vscodeScript}</head>`);
    return html;
  }

  // ============================================================================
  // Public API Methods - delegate to appropriate managers
  // ============================================================================

  /**
   * Toggles debug mode on/off
   */
  public async toggleDebugMode(): Promise<void> {
    const newDebugMode = !this.state.isApexDebuggingEnabled;
    await this.state.setDebugMode(newDebugMode);

    if (this.state.agentInstance) {
      this.state.agentInstance.preview.setApexDebugging(newDebugMode);
    }

    const statusMessage = newDebugMode ? 'Debug mode activated.' : 'Debug mode deactivated.';
    vscode.window.showInformationMessage(statusMessage);
  }

  /**
   * Gets the currently selected agent ID
   */
  public get hasAuthError(): boolean {
    return this.state.hasAuthError;
  }

  public getCurrentAgentId(): string | undefined {
    return this.state.currentAgentId;
  }

  /**
   * Gets the currently selected agent source
   */
  public getCurrentAgentSource(): string | undefined {
    return this.state.currentAgentSource;
  }

  /**
   * Selects an agent and starts a session
   */
  public selectAndStartAgent(agentId: string): void {
    if (this.webviewView) {
      this.messageSender.sendSelectAgent(agentId, true);
    }
  }

  /**
   * Ends the current agent session
   */
  public async endSession(): Promise<void> {
    await this.sessionManager.endSession(async () => {
      const agentId = this.state.pendingStartAgentId ?? this.state.currentAgentId;
      if (agentId) {
        const agentSource = this.state.pendingStartAgentSource ?? (await getAgentSource(agentId));
        await this.historyManager.showHistoryOrPlaceholder(agentId, agentSource);
      }
    });
  }

  /**
   * Restarts the agent session without recompilation
   */
  public async restartWithoutCompilation(): Promise<void> {
    await this.sessionManager.restartSession();
  }

  /**
   * Recompiles and restarts the agent session (full restart with compilation)
   */
  public async recompileAndRestart(): Promise<void> {
    await this.sessionManager.recompileAndRestartSession();
  }

  /**
   * Sets the agent ID
   */
  public setAgentId(agentId: string): void {
    this.state.currentAgentId = agentId;
  }

  /**
   * Starts a preview session for an agent
   */
  public async startPreviewSession(agentId: string, agentSource: AgentSource, isLiveMode?: boolean): Promise<void> {
    if (!this.webviewView) {
      throw new Error('Webview is not ready. Please ensure the view is visible.');
    }

    await this.sessionManager.startSession(agentId, agentSource, isLiveMode, this.webviewView);
  }

  /**
   * Refreshes the available agents list
   * @param selectAgentId Optional agent ID to auto-select after refresh
   */
  public async refreshAvailableAgents(selectAgentId?: string): Promise<void> {
    // Force re-read of sfdx-project.json so new packageDirectories are picked up
    SfProject.clearInstances();

    // Clear state and update UI immediately (optimistic update)
    this.state.currentAgentId = undefined;

    // Set pending select agent ID if provided (will be used when agents are loaded)
    this.state.pendingSelectAgentId = selectAgentId;

    if (this.webviewView) {
      this.state.currentAgentName = undefined;
      await this.state.setAgentSelected(false);
      await this.state.setSessionActive(false);
      await this.state.setSessionStarting(false);
      await this.state.setResetAgentViewAvailable(false);
      this.state.pendingStartAgentId = undefined;
      this.state.pendingStartAgentSource = undefined;

      this.messageSender.sendSelectAgent('', false);
      this.messageSender.sendClearMessages();
      this.messageSender.sendNoHistoryFound('refresh-placeholder');
      this.messageSender.sendRefreshAgents();
    }

    // End session in background (non-blocking) - restoreConnection can be slow
    void this.endSession();
  }

  /**
   * Gets agents for command palette
   */
  public async getAgentsForCommandPalette(): Promise<PreviewableAgent[]> {
    try {
      const conn = await CoreExtensionService.getDefaultConnection();
      const project = SfProject.getInstance();
      return await Agent.listPreviewable(conn, project);
    } catch (error) {
      console.error('Error getting agents for command palette:', error);
      return [];
    }
  }

  /**
   * Resets the current agent view
   */
  /**
   * Drops the currently displayed (resumable) conversation/traces so the user can
   * start a fresh session from an empty chat. Does not touch on-disk session data.
   */
  public clearLoadedSession(): void {
    this.state.previewedSessionId = undefined;
    this.state.currentPlanId = undefined;
    void this.state.setConversationDataAvailable(false);
    this.messageSender.sendSetConversation([], true, null);
    if (this.state.currentAgentId) {
      this.messageSender.sendTraceHistory(this.state.currentAgentId, []);
    }
    this.messageSender.sendTraceData({ plan: [], planId: '', sessionId: '' });
  }

  public async resetCurrentAgentView(): Promise<void> {
    if (!this.webviewView) {
      throw new Error('Agent view is not ready to reset.');
    }

    if (!this.state.currentAgentId) {
      throw new Error('No agent selected to reset.');
    }

    // Optimistic update: clear UI and update context immediately
    this.messageSender.sendClearMessages();
    await this.state.setResetAgentViewAvailable(false);
    await this.state.setSessionErrorState(false);

    // Load history in background (non-blocking)
    // Use stored agentSource to avoid slow getAgentSource call
    const agentId = this.state.currentAgentId;
    const agentSource = this.state.currentAgentSource ?? (await getAgentSource(agentId));
    void this.historyManager.showHistoryOrPlaceholder(agentId, agentSource);
  }

  /**
   * Re-fetches and sends the active version info for the currently selected agent.
   * Used to sync the panel after an external activation (e.g. context menu).
   */
  public refreshActiveVersion(): void {
    const agentId = this.state.currentAgentId;
    if (!agentId || !this.messageHandlers) {
      return;
    }
    this.messageHandlers.fetchAndSendActiveVersion(agentId).catch(err => {
      console.error('Error refreshing active version:', err);
    });
  }

  /**
   * Shows a QuickPick to select and activate a version for the current published agent
   */
  public async activateVersion(): Promise<void> {
    const agentId = this.state.currentAgentId;
    if (!agentId) {
      vscode.window.showErrorMessage('No agent selected.');
      return;
    }

    // Use cached versions from the agent list load for instant picker
    const cachedVersions = this.state.agentVersionsCache.get(agentId);
    if (!cachedVersions || cachedVersions.length === 0) {
      vscode.window.showErrorMessage('No versions found for this agent.');
      return;
    }

    const versionItems = buildVersionPickerItems(cachedVersions, { includeDeactivate: true });

    const picked = await vscode.window.showQuickPick(versionItems, {
      placeHolder: 'Select a version to activate'
    });

    if (!picked) {
      return;
    }

    if (picked.action === 'deactivate') {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Deactivating agent...',
          cancellable: false
        },
        async () => {
          const conn = await CoreExtensionService.getDefaultConnection();
          const project = SfProject.getInstance();
          const agent = await Agent.init({ connection: conn, project, apiNameOrId: agentId });
          await agent.deactivate();

          // Update cache
          const versions = this.state.agentVersionsCache.get(agentId);
          if (versions) {
            for (const v of versions) {
              v.Status = 'Inactive';
            }
          }

          this.state.currentAgentActiveVersion = undefined;
          this.state.pendingSelectAgentId = agentId;
          this.messageSender.sendAgentVersionInfo(agentId, undefined);
          this.messageSender.sendRefreshAgents();
          vscode.window.showInformationMessage('Agent deactivated.');
        }
      );
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Activating version ${picked.versionNumber}...`,
        cancellable: false
      },
      async () => {
        const conn = await CoreExtensionService.getDefaultConnection();
        const project = SfProject.getInstance();
        const agent = await Agent.init({ connection: conn, project, apiNameOrId: agentId });
        const result = await agent.activate(picked.versionNumber!);
        const activatedVersion = result.VersionNumber as number;

        // Update cache to reflect the new active version
        const versions = this.state.agentVersionsCache.get(agentId);
        if (versions) {
          for (const v of versions) {
            v.Status = v.VersionNumber === activatedVersion ? 'Active' : 'Inactive';
          }
        }

        this.state.currentAgentActiveVersion = activatedVersion;
        this.messageSender.sendAgentVersionInfo(agentId, activatedVersion);
        this.messageSender.sendRefreshAgents();
        vscode.window.showInformationMessage(`Version ${activatedVersion} activated.`);
      }
    );
  }

  /**
   * Saves the current conversation session, always prompting for a location.
   * The folder picker defaults to the previously selected directory.
   */
  public async exportConversation(): Promise<void> {
    await this.doExportConversation();
  }

  private async doExportConversation(): Promise<void> {
    const agentId = this.state.currentAgentId;
    const agentSource = this.state.currentAgentSource;

    if (!agentId || !agentSource) {
      vscode.window.showWarningMessage('No agent selected to save session.');
      return;
    }

    const savedDir = this.state.getExportDirectory();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const defaultUri = savedDir
      ? vscode.Uri.file(savedDir)
      : workspaceFolder?.uri;

    const selectedFolder = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Save Chat History',
      title: 'Select folder to save chat history',
      defaultUri
    });

    if (!selectedFolder || selectedFolder.length === 0) {
      return; // User cancelled
    }

    const targetDirectory = selectedFolder[0].fsPath;
    await this.state.setExportDirectory(targetDirectory);

    try {
      // If there's an active session, use the library's saveSession method
      if (this.state.isSessionActive && this.state.agentInstance) {
        await this.state.agentInstance.preview.saveSession(targetDirectory);
        vscode.window.showInformationMessage(`Conversation session saved to ${targetDirectory}.`);
        return;
      }

      // No active session - save from loaded history by copying the session directory
      const agentStorageKey = getAgentStorageKey(agentId, agentSource);

      // Get history to find the session ID (getAllHistory finds the most recent session when sessionId is undefined)
      const history = await getAllHistory(agentStorageKey, undefined);

      if (!history.metadata?.sessionId) {
        vscode.window.showWarningMessage('No conversation history found to save.');
        return;
      }

      const sessionId = history.metadata.sessionId;

      // Get the source directory path where the session is stored
      const sourceDir = await getHistoryDir(agentStorageKey, sessionId);

      // Create destination directory matching the library's format: {outputDir}/{agentId}/session_{sessionId}/
      const destDir = path.join(targetDirectory, agentStorageKey, `session_${sessionId}`);
      await fs.promises.mkdir(destDir, { recursive: true });

      // Copy the entire session directory
      await fs.promises.cp(sourceDir, destDir, { recursive: true });

      vscode.window.showInformationMessage(`Conversation session saved to ${destDir}.`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to save conversation: ${errorMessage}`);
    }
  }

}
