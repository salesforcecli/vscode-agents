/*
 * Copyright 2025, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Mock VS Code
jest.mock('vscode', () => ({
  commands: {
    executeCommand: jest.fn()
  },
  window: {
    showInformationMessage: jest.fn(),
    showErrorMessage: jest.fn()
  },
  workspace: {
    getConfiguration: jest.fn(() => ({
      get: jest.fn()
    }))
  }
}));

// Mock @salesforce/agents
jest.mock('@salesforce/agents', () => ({
  AgentSource: {
    SCRIPT: 'script',
    PUBLISHED: 'published'
  },
  Agent: {
    listPreviewable: jest.fn()
  }
}));

// Mock @salesforce/core
jest.mock('@salesforce/core', () => ({
  SfProject: {
    getInstance: () => ({
      getPath: () => '/mock/project'
    })
  },
  SfError: {
    wrap: (err: unknown) => (err instanceof Error ? err : new Error(String(err)))
  }
}));

// Mock CoreExtensionService
jest.mock('../../../../src/services/coreExtensionService', () => ({
  CoreExtensionService: {
    getDefaultConnection: jest.fn().mockResolvedValue({
      instanceUrl: 'https://test.salesforce.com'
    }),
    getChannelService: jest.fn(() => ({
      appendLine: jest.fn(),
      showChannelOutput: jest.fn()
    }))
  }
}));

// Mock agentUtils
jest.mock('../../../../src/views/agentCombined/agent/agentUtils', () => ({
  getAgentSource: jest.fn()
}));

// Mock sessionHistoryService (the session/index reexports it)
jest.mock('../../../../src/views/agentCombined/session', () => ({
  listSessionsForAgent: jest.fn()
}));

// Import after mocks
import { WebviewMessageHandlers } from '../../../../src/views/agentCombined/handlers/webviewMessageHandlers';
import { CoreExtensionService } from '../../../../src/services/coreExtensionService';
import { listSessionsForAgent } from '../../../../src/views/agentCombined/session';

describe('WebviewMessageHandlers', () => {
  let handlers: WebviewMessageHandlers;
  let mockState: any;
  let mockMessageSender: any;
  let mockSessionManager: any;
  let mockHistoryManager: any;
  let mockApexDebugManager: any;
  let mockContext: any;
  let mockWebviewView: any;
  let mockChannelService: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockState = {
      agentInstance: undefined,
      sessionId: '',
      sessionAgentId: undefined,
      currentAgentId: undefined,
      currentAgentSource: undefined,
      currentPlanId: undefined,
      previewedSessionId: undefined,
      isSessionActive: false,
      isSessionStarting: false,
      pendingStartAgentId: undefined,
      pendingStartAgentSource: undefined,
      setSessionActive: jest.fn().mockResolvedValue(undefined),
      setSessionStarting: jest.fn().mockResolvedValue(undefined),
      setSessionStopping: jest.fn().mockResolvedValue(undefined),
      setResetAgentViewAvailable: jest.fn().mockResolvedValue(undefined),
      setSessionErrorState: jest.fn().mockResolvedValue(undefined),
      setConversationDataAvailable: jest.fn().mockResolvedValue(undefined),
      setAuthError: jest.fn().mockResolvedValue(undefined),
      setHasAgents: jest.fn().mockResolvedValue(undefined),
      agentVersionsCache: new Map(),
      pendingSelectAgentId: undefined,
      cancelPendingSessionStart: jest.fn(),
      clearSessionState: jest.fn()
    };

    mockMessageSender = {
      sendError: jest.fn().mockResolvedValue(undefined),
      sendAuthError: jest.fn(),
      sendAvailableAgents: jest.fn(),
      sendClearMessages: jest.fn(),
      sendSessionList: jest.fn(),
      sendSessionStarting: jest.fn(),
      sendSessionEnded: jest.fn(),
      sendSetConversation: jest.fn(),
      sendTraceHistory: jest.fn(),
      sendTraceData: jest.fn()
    };

    mockSessionManager = {
      startSession: jest.fn(),
      endSession: jest.fn(),
      resumeSession: jest.fn().mockResolvedValue(undefined)
    };

    mockHistoryManager = {
      loadAndSendTraceHistory: jest.fn().mockResolvedValue(undefined),
      showHistoryOrPlaceholder: jest.fn(),
      loadAndSendSessionPreview: jest.fn().mockResolvedValue(undefined),
      loadAndSendTracesForSession: jest.fn().mockResolvedValue(undefined)
    };

    mockApexDebugManager = {};

    mockContext = {};

    mockChannelService = {
      appendLine: jest.fn(),
      showChannelOutput: jest.fn()
    };

    // Ensure getChannelService returns our mock so Logger gets a valid channelService
    jest.spyOn(CoreExtensionService, 'getChannelService').mockReturnValue(mockChannelService as any);

    mockWebviewView = {
      webview: {
        postMessage: jest.fn()
      }
    };

    handlers = new WebviewMessageHandlers(
      mockState,
      mockMessageSender,
      mockSessionManager,
      mockHistoryManager,
      mockApexDebugManager,
      mockContext,
      mockWebviewView
    );
  });

  describe('handleError', () => {
    // Suppress console.error for expected error logs
    const originalError = console.error;
    beforeAll(() => {
      console.error = jest.fn();
    });
    afterAll(() => {
      console.error = originalError;
    });

    it('should display deactivation message for deactivated agent error', async () => {
      const error = new Error('404 NOT_FOUND: No valid version available for this agent');

      await handlers.handleError(error);

      expect(mockMessageSender.sendError).toHaveBeenCalledWith(
        'Agent deactivated',
        expect.stringContaining('currently deactivated')
      );
    });

    it('should display not found message for deleted agent error', async () => {
      const error = new Error('404 NOT_FOUND: Agent does not exist');

      await handlers.handleError(error);

      expect(mockMessageSender.sendError).toHaveBeenCalledWith(
        'Agent not found',
        expect.stringContaining("couldn't be found")
      );
    });

    it('should display permission message for forbidden error', async () => {
      const error = new Error('403 FORBIDDEN: Access denied');

      await handlers.handleError(error);

      expect(mockMessageSender.sendError).toHaveBeenCalledWith(
        'Permission denied',
        expect.stringContaining("don't have permission")
      );
    });

    it('should display generic message with technical details for unknown errors', async () => {
      const error = new Error('Something unexpected happened');

      await handlers.handleError(error);

      expect(mockMessageSender.sendError).toHaveBeenCalledWith(
        'Something went wrong',
        'Something unexpected happened'
      );
    });

    it('should set error state flags', async () => {
      const error = new Error('Any error');

      await handlers.handleError(error);

      expect(mockState.setResetAgentViewAvailable).toHaveBeenCalledWith(true);
      expect(mockState.setSessionErrorState).toHaveBeenCalledWith(true);
    });

    it('should clear session state if session was active', async () => {
      mockState.isSessionActive = true;
      const error = new Error('Any error');

      await handlers.handleError(error);

      expect(mockState.clearSessionState).toHaveBeenCalled();
      expect(mockState.setSessionActive).toHaveBeenCalledWith(false);
      expect(mockState.setSessionStarting).toHaveBeenCalledWith(false);
    });

    it('should clear pending start agent info', async () => {
      mockState.pendingStartAgentId = 'test-agent';
      mockState.pendingStartAgentSource = 'published';
      const error = new Error('Any error');

      await handlers.handleError(error);

      expect(mockState.pendingStartAgentId).toBeUndefined();
      expect(mockState.pendingStartAgentSource).toBeUndefined();
    });

    it('should log error to channel service', async () => {
      const error = new Error('Test error message');

      await handlers.handleError(error);

      expect(mockChannelService.appendLine).toHaveBeenCalledWith(
        expect.stringContaining('[error] AgentCombinedViewProvider error')
      );
    });
  });

  describe('listSessions', () => {
    it('posts the session list back to the webview', async () => {
      const sessions = [
        { sessionId: 'a', timestamp: '2026-05-10T00:00:00Z', sessionType: 'live', firstUserMessage: 'hi' }
      ];
      (listSessionsForAgent as jest.Mock).mockResolvedValue(sessions);

      await handlers.handleMessage({
        command: 'listSessions',
        data: { agentId: 'agent-1', agentSource: 'script' }
      } as any);

      expect(listSessionsForAgent).toHaveBeenCalledWith('agent-1', 'script');
      expect(mockMessageSender.sendSessionList).toHaveBeenCalledWith('agent-1', sessions);
    });

    it('returns an empty list when no agentId is supplied or known', async () => {
      await handlers.handleMessage({ command: 'listSessions', data: {} } as any);

      expect(mockMessageSender.sendSessionList).toHaveBeenCalledWith('', []);
      expect(listSessionsForAgent).not.toHaveBeenCalled();
    });

    it('falls back to an empty list when listing throws', async () => {
      (listSessionsForAgent as jest.Mock).mockRejectedValue(new Error('boom'));
      const originalError = console.error;
      console.error = jest.fn();

      await handlers.handleMessage({
        command: 'listSessions',
        data: { agentId: 'agent-1', agentSource: 'script' }
      } as any);

      expect(mockMessageSender.sendSessionList).toHaveBeenCalledWith('agent-1', []);
      console.error = originalError;
    });
  });

  describe('previewSession', () => {
    it('loads the session preview and records previewedSessionId', async () => {
      mockState.currentAgentSource = 'script';

      await handlers.handleMessage({
        command: 'previewSession',
        data: { agentId: 'agent-1', sessionId: 'sess-1' }
      } as any);

      expect(mockHistoryManager.loadAndSendSessionPreview).toHaveBeenCalledWith(
        'agent-1',
        'script',
        'sess-1',
        undefined
      );
      expect(mockState.previewedSessionId).toBe('sess-1');
      expect(mockSessionManager.resumeSession).not.toHaveBeenCalled();
    });

    it('short-circuits when the requested session is already active', async () => {
      mockState.isSessionActive = true;
      mockState.sessionId = 'sess-1';
      mockState.sessionAgentId = 'agent-1';
      mockState.currentAgentSource = 'script';

      await handlers.handleMessage({
        command: 'previewSession',
        data: { agentId: 'agent-1', sessionId: 'sess-1' }
      } as any);

      expect(mockHistoryManager.loadAndSendSessionPreview).not.toHaveBeenCalled();
    });

    it('throws when sessionId is missing', async () => {
      await expect(
        handlers.handleMessage({
          command: 'previewSession',
          data: { agentId: 'agent-1' }
        } as any)
      ).rejects.toThrow(/Invalid session ID/);
    });
  });

  describe('endSession message wiring', () => {
    it('forwards restarting=true from the message data to sessionManager.endSession', async () => {
      // The App.tsx restart queue posts endSession({ restarting: true }) when
      // a mode switch or agent change drives a stop-then-start. The handler
      // must propagate that flag so sessionManager skips marking the session
      // previewable; otherwise the upcoming startSession routes through
      // resume.
      await handlers.handleMessage({
        command: 'endSession',
        data: { restarting: true }
      } as any);

      expect(mockSessionManager.endSession).toHaveBeenCalledTimes(1);
      const [, options] = mockSessionManager.endSession.mock.calls[0];
      expect(options).toEqual({ restarting: true });
    });

    it('passes restarting=false when the message has no data (user-initiated Stop)', async () => {
      await handlers.handleMessage({ command: 'endSession' } as any);

      expect(mockSessionManager.endSession).toHaveBeenCalledTimes(1);
      const [, options] = mockSessionManager.endSession.mock.calls[0];
      expect(options).toEqual({ restarting: false });
    });

    it('passes restarting=false when the data omits the flag', async () => {
      await handlers.handleMessage({ command: 'endSession', data: {} } as any);

      expect(mockSessionManager.endSession).toHaveBeenCalledTimes(1);
      const [, options] = mockSessionManager.endSession.mock.calls[0];
      expect(options).toEqual({ restarting: false });
    });
  });

  describe('startSession with previewed session', () => {
    it('routes through resumeSession when a previewed session is set for the same agent', async () => {
      mockState.currentAgentId = 'agent-1';
      mockState.currentAgentSource = 'script';
      mockState.previewedSessionId = 'sess-prior';

      await handlers.handleMessage({
        command: 'startSession',
        data: { agentId: 'agent-1', isLiveMode: true }
      } as any);

      expect(mockSessionManager.resumeSession).toHaveBeenCalledWith(
        'agent-1',
        'script',
        'sess-prior',
        true,
        mockWebviewView
      );
      expect(mockSessionManager.startSession).not.toHaveBeenCalled();
      expect(mockState.previewedSessionId).toBeUndefined();
    });
  });

  describe('previewSession with active live session', () => {
    it('ends the SDK session and surfaces the stopping spinner before loading the preview', async () => {
      const previewEnd = jest.fn().mockResolvedValue(undefined);
      const restoreConnection = jest.fn().mockResolvedValue(undefined);
      mockState.currentAgentId = 'agent-1';
      mockState.currentAgentSource = 'published';
      mockState.sessionId = 'live-session';
      mockState.sessionAgentId = 'agent-1';
      mockState.isSessionActive = true;
      mockState.agentInstance = { preview: { end: previewEnd }, restoreConnection };

      await handlers.handleMessage({
        command: 'previewSession',
        data: { agentId: 'agent-1', sessionId: 'sess-old', sessionType: 'live' }
      } as any);

      expect(mockState.cancelPendingSessionStart).toHaveBeenCalled();
      expect(mockMessageSender.sendSetConversation).toHaveBeenCalledWith([], true, null);
      expect(mockMessageSender.sendTraceHistory).toHaveBeenCalledWith('agent-1', []);
      expect(mockMessageSender.sendSessionStarting).toHaveBeenCalledWith('Stopping session...');
      // Published agents end with 'UserRequest'
      expect(previewEnd).toHaveBeenCalledWith('UserRequest');
      expect(restoreConnection).toHaveBeenCalled();
      expect(mockState.clearSessionState).toHaveBeenCalled();
      expect(mockHistoryManager.loadAndSendSessionPreview).toHaveBeenCalledWith(
        'agent-1',
        'published',
        'sess-old',
        'live'
      );
      expect(mockMessageSender.sendSessionEnded).toHaveBeenCalled();
      expect(mockState.previewedSessionId).toBe('sess-old');
    });

    it('flips sessionActive=false and emits sessionStarting before invoking the SDK end', async () => {
      const callOrder: string[] = [];
      const previewEnd = jest.fn().mockImplementation(async () => {
        callOrder.push('preview.end');
      });
      mockState.setSessionActive.mockImplementation(async (active: boolean) => {
        if (active === false) callOrder.push('setSessionActive(false)');
      });
      mockMessageSender.sendSessionStarting.mockImplementation(() => {
        callOrder.push('sendSessionStarting');
      });
      mockMessageSender.sendSetConversation.mockImplementation((messages: any[]) => {
        if (messages.length === 0) callOrder.push('sendSetConversation(empty)');
      });
      mockState.currentAgentId = 'agent-1';
      mockState.currentAgentSource = 'published';
      mockState.sessionId = 'live-session';
      mockState.agentInstance = {
        preview: { end: previewEnd },
        restoreConnection: jest.fn().mockResolvedValue(undefined)
      };

      await handlers.handleMessage({
        command: 'previewSession',
        data: { agentId: 'agent-1', sessionId: 'sess-old', sessionType: 'live' }
      } as any);

      // sessionActive must flip to false before the SDK round-trip so toolbar
      // actions gated on it (debug, stop) hide immediately.
      expect(callOrder.indexOf('setSessionActive(false)')).toBeLessThan(
        callOrder.indexOf('preview.end')
      );
      // sessionStarting must precede the empty setConversation so the webview's
      // isSessionStartingRef is true when the empty payload arrives.
      expect(callOrder.indexOf('sendSessionStarting')).toBeLessThan(
        callOrder.indexOf('sendSetConversation(empty)')
      );
    });

    it('uses preview.end() with no args for script agents', async () => {
      const previewEnd = jest.fn().mockResolvedValue(undefined);
      mockState.currentAgentId = 'agent-1';
      mockState.currentAgentSource = 'script';
      mockState.sessionId = 'live-session';
      mockState.agentInstance = {
        preview: { end: previewEnd },
        restoreConnection: jest.fn().mockResolvedValue(undefined)
      };

      await handlers.handleMessage({
        command: 'previewSession',
        data: { agentId: 'agent-1', sessionId: 'sess-old', sessionType: 'simulated' }
      } as any);

      expect(previewEnd).toHaveBeenCalledWith();
    });
  });

  describe('handleGetTraceData with previewed session', () => {
    it('routes to loadAndSendTracesForSession when previewing', async () => {
      mockState.currentAgentId = 'agent-1';
      mockState.currentAgentSource = 'script';
      mockState.previewedSessionId = 'sess-old';
      mockState.isSessionActive = false;

      await handlers.handleMessage({ command: 'getTraceData' } as any);

      expect(mockHistoryManager.loadAndSendTracesForSession).toHaveBeenCalledWith(
        'agent-1',
        'script',
        'sess-old'
      );
      expect(mockHistoryManager.loadAndSendTraceHistory).not.toHaveBeenCalled();
    });

    it('falls back to loadAndSendTraceHistory when not previewing', async () => {
      mockState.currentAgentId = 'agent-1';
      mockState.currentAgentSource = 'script';
      mockState.previewedSessionId = undefined;

      await handlers.handleMessage({ command: 'getTraceData' } as any);

      expect(mockHistoryManager.loadAndSendTraceHistory).toHaveBeenCalledWith('agent-1', 'script');
      expect(mockHistoryManager.loadAndSendTracesForSession).not.toHaveBeenCalled();
    });

    it('falls back to loadAndSendTraceHistory when a session is active even if previewedSessionId is set', async () => {
      mockState.currentAgentId = 'agent-1';
      mockState.currentAgentSource = 'script';
      mockState.previewedSessionId = 'sess-old';
      mockState.isSessionActive = true;

      await handlers.handleMessage({ command: 'getTraceData' } as any);

      expect(mockHistoryManager.loadAndSendTraceHistory).toHaveBeenCalled();
      expect(mockHistoryManager.loadAndSendTracesForSession).not.toHaveBeenCalled();
    });
  });

  describe('handleGetAvailableAgents - connection errors', () => {
    const originalError = console.error;
    beforeAll(() => {
      console.error = jest.fn();
    });
    afterAll(() => {
      console.error = originalError;
    });

    it('sends authError when RefreshTokenAuthError occurs', async () => {
      const error = new Error('Error authenticating with the refresh token due to: authentication failure');
      error.name = 'RefreshTokenAuthError';
      (CoreExtensionService.getDefaultConnection as jest.Mock).mockRejectedValueOnce(error);

      await handlers.handleMessage({ command: 'getAvailableAgents' } as any);

      expect(mockMessageSender.sendAuthError).toHaveBeenCalledWith(
        'Unable to connect to org',
        'Set a new default org or re-authenticate to continue.'
      );
      expect(mockState.setAuthError).toHaveBeenCalledWith(true);
      expect(mockMessageSender.sendAvailableAgents).not.toHaveBeenCalled();
    });

    it('sends authError when INVALID_CROSS_REFERENCE_KEY occurs', async () => {
      const error = new Error('invalid cross reference id');
      error.name = 'INVALID_CROSS_REFERENCE_KEY';
      (CoreExtensionService.getDefaultConnection as jest.Mock).mockRejectedValueOnce(error);

      await handlers.handleMessage({ command: 'getAvailableAgents' } as any);

      expect(mockMessageSender.sendAuthError).toHaveBeenCalledWith(
        'Unable to connect to org',
        'Set a new default org or re-authenticate to continue.'
      );
      expect(mockState.setAuthError).toHaveBeenCalledWith(true);
    });

    it('sends authError when INVALID_SESSION_ID occurs', async () => {
      const error = new Error('INVALID_SESSION_ID: Session expired or invalid');
      (CoreExtensionService.getDefaultConnection as jest.Mock).mockRejectedValueOnce(error);

      await handlers.handleMessage({ command: 'getAvailableAgents' } as any);

      expect(mockMessageSender.sendAuthError).toHaveBeenCalled();
      expect(mockState.setAuthError).toHaveBeenCalledWith(true);
    });

    it('sends authError when no default org is configured', async () => {
      const error = new Error('No default org configured. Set a default org with: sf config set target-org=<username>');
      (CoreExtensionService.getDefaultConnection as jest.Mock).mockRejectedValueOnce(error);

      await handlers.handleMessage({ command: 'getAvailableAgents' } as any);

      expect(mockMessageSender.sendAuthError).toHaveBeenCalled();
      expect(mockState.setAuthError).toHaveBeenCalledWith(true);
    });

    it('sends authError with feature-not-enabled message when BotDefinition INVALID_TYPE occurs', async () => {
      const error = new Error("sObject type 'BotDefinition' is not supported.");
      error.name = 'INVALID_TYPE';
      (CoreExtensionService.getDefaultConnection as jest.Mock).mockRejectedValueOnce(error);

      await handlers.handleMessage({ command: 'getAvailableAgents' } as any);

      expect(mockMessageSender.sendAuthError).toHaveBeenCalledWith(
        'Agentforce is not enabled',
        'This org does not have Agentforce enabled. Select an org with Agentforce to continue.'
      );
      expect(mockState.setAuthError).toHaveBeenCalledWith(true);
    });

    it('sends empty agent list for non-connection errors', async () => {
      const error = new Error('Some unexpected error');
      (CoreExtensionService.getDefaultConnection as jest.Mock).mockRejectedValueOnce(error);

      await handlers.handleMessage({ command: 'getAvailableAgents' } as any);

      expect(mockMessageSender.sendAvailableAgents).toHaveBeenCalledWith([], undefined);
      expect(mockMessageSender.sendAuthError).not.toHaveBeenCalled();
      expect(mockState.setAuthError).not.toHaveBeenCalled();
    });

    it('sets hasAgents to false on any error', async () => {
      const error = new Error('authentication failure');
      (CoreExtensionService.getDefaultConnection as jest.Mock).mockRejectedValueOnce(error);

      await handlers.handleMessage({ command: 'getAvailableAgents' } as any);

      expect(mockState.setHasAgents).toHaveBeenCalledWith(false);
    });
  });
});
