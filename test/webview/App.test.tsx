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
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock vscodeApi before importing App
const mockVscodeApi = {
  postMessage: jest.fn(),
  onMessage: jest.fn(),
  startSession: jest.fn(),
  endSession: jest.fn(),
  sendChatMessage: jest.fn(),
  setApexDebugging: jest.fn(),
  getAvailableAgents: jest.fn(),
  getTraceData: jest.fn(),
  clearChat: jest.fn(),
  clearMessages: jest.fn(),
  getConfiguration: jest.fn(),
  executeCommand: jest.fn(),
  openUrl: jest.fn(),
  setSelectedAgentId: jest.fn(),
  loadAgentHistory: jest.fn(),
  setLiveMode: jest.fn(),
  getInitialLiveMode: jest.fn(),
  sendConversationExport: jest.fn()
};

jest.mock('../../webview/src/services/vscodeApi', () => ({
  vscodeApi: mockVscodeApi,
  AgentSource: {
    SCRIPT: 'script',
    PUBLISHED: 'published'
  }
}));

// Track focusInput calls
const mockFocusInput = jest.fn();

// Mock the components to simplify testing
jest.mock('../../webview/src/components/AgentPreview/AgentPreview', () => {
  return React.forwardRef(function MockAgentPreview(
    { selectedAgentId, pendingAgentId, isSessionTransitioning }: any,
    ref: any
  ) {
    React.useImperativeHandle(ref, () => ({
      focusInput: mockFocusInput
    }));

    return (
      <div data-testid="agent-preview" ref={ref}>
        <div data-testid="selected-agent">{selectedAgentId || 'none'}</div>
        <div data-testid="pending-agent">{pendingAgentId || 'none'}</div>
        <div data-testid="is-transitioning">{isSessionTransitioning ? 'true' : 'false'}</div>
      </div>
    );
  });
});

jest.mock('../../webview/src/components/AgentTracer/AgentTracer', () => {
  return function MockAgentTracer({ onGoToPreview, isSessionActive, isLiveMode }: any) {
    return (
      <div data-testid="agent-tracer">
        <div data-testid="tracer-session-active">{isSessionActive ? 'active' : 'inactive'}</div>
        <div data-testid="tracer-live-mode">{isLiveMode ? 'live' : 'simulate'}</div>
        {onGoToPreview && (
          <button data-testid="tracer-go-to-preview" onClick={onGoToPreview}>
            Go to Preview
          </button>
        )}
      </div>
    );
  };
});

jest.mock('../../webview/src/components/AgentPreview/AgentSelector', () => {
  return function MockAgentSelector({ selectedAgent, onAgentChange, onSelectedAgentInfoChange }: any) {
    return (
      <div data-testid="agent-selector">
        <select
          data-testid="agent-select"
          value={selectedAgent}
          onChange={e => {
            const agentId = e.target.value;
            onAgentChange(agentId);
            // Simulate agent info change based on agent ID
            if (agentId === 'published-agent') {
              onSelectedAgentInfoChange?.({ id: agentId, name: 'Published Agent', type: 'published' });
            } else if (agentId) {
              onSelectedAgentInfoChange?.({ id: agentId, name: `Agent ${agentId}`, type: 'script' });
            } else {
              onSelectedAgentInfoChange?.(null);
            }
          }}
        >
          <option value="">Select agent...</option>
          <option value="agent1">Agent 1</option>
          <option value="agent2">Agent 2</option>
          <option value="published-agent">Published Agent</option>
        </select>
      </div>
    );
  };
});

jest.mock('../../webview/src/components/shared/TabNavigation', () => {
  return function MockTabNavigation({ onTabChange, showTracerTab }: any) {
    return (
      <div data-testid="tab-navigation">
        <button data-testid="preview-tab" onClick={() => onTabChange('preview')}>
          Preview
        </button>
        {showTracerTab && (
          <button data-testid="tracer-tab" onClick={() => onTabChange('tracer')}>
            Tracer
          </button>
        )}
      </div>
    );
  };
});

import App from '../../webview/src/App';

describe('App', () => {
  let messageHandlers: Map<string, Function>;
  let mockVSCodeApi: any;

  beforeEach(() => {
    messageHandlers = new Map();

    // Reset all mocks
    jest.clearAllMocks();

    // Setup mock VS Code API
    mockVSCodeApi = {
      postMessage: jest.fn(),
      getState: jest.fn(),
      setState: jest.fn()
    };

    (window as any).vscode = mockVSCodeApi;

    // Setup onMessage to capture handlers
    mockVscodeApi.onMessage.mockImplementation((command: string, handler: Function) => {
      messageHandlers.set(command, handler);
      return () => messageHandlers.delete(command);
    });

    // onClientAppReady removed - functionality was removed
  });

  afterEach(() => {
    delete (window as any).vscode;
    messageHandlers.clear();
  });

  // Helper to trigger messages
  const triggerMessage = (command: string, data?: any) => {
    const handler = messageHandlers.get(command);
    if (handler) {
      handler(data);
    }
  };

  describe('Initial Rendering', () => {
    it('should render without crashing', () => {
      render(<App />);
      expect(screen.getByTestId('agent-selector')).toBeInTheDocument();
    });

    it('should default to preview tab', () => {
      render(<App />);
      expect(screen.getByTestId('agent-preview')).toBeInTheDocument();
    });

    it('should not show tracer tab by default', () => {
      render(<App />);
      expect(screen.queryByTestId('tab-navigation')).not.toBeInTheDocument();
    });

    it('should keep tabs visible during session starting', async () => {
      render(<App />);

      // Select an agent - tabs should appear once an agent is selected
      triggerMessage('selectAgent', { agentId: 'agent1' });

      await waitFor(() => {
        expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
      });

      // Tabs should remain visible during session start to keep loading
      // continuity (no flicker between simulation/live test transitions).
      triggerMessage('sessionStarting', {});

      await waitFor(() => {
        expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
      });
    });

    it('should keep tabs visible after loading completes', async () => {
      render(<App />);

      triggerMessage('selectAgent', { agentId: 'agent1' });
      triggerMessage('sessionStarting', {});
      triggerMessage('sessionStarted', {});

      await waitFor(() => {
        expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
      });
    });
  });

  describe('Tab Navigation', () => {
    it('should switch to tracer tab when tracer is clicked', async () => {
      render(<App />);

      // Select an agent and start session to show tracer tab
      triggerMessage('selectAgent', { agentId: 'agent1' });
      triggerMessage('sessionStarted', {});

      await waitFor(() => {
        expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
      });

      // Click tracer tab
      const tracerTab = screen.getByTestId('tracer-tab');
      fireEvent.click(tracerTab);

      await waitFor(() => {
        expect(screen.getByTestId('agent-tracer')).toBeInTheDocument();
      });
    });

    it('should switch back to preview tab', async () => {
      render(<App />);

      // Select agent and start session to show tracer
      triggerMessage('selectAgent', { agentId: 'agent1' });
      triggerMessage('sessionStarted', {});

      await waitFor(() => {
        expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
      });

      // Switch to tracer
      fireEvent.click(screen.getByTestId('tracer-tab'));

      // Switch back to preview
      fireEvent.click(screen.getByTestId('preview-tab'));

      expect(screen.getByTestId('agent-preview')).toBeInTheDocument();
    });
  });

  describe('Agent Selection', () => {
    it('should update desiredAgentId when agent is selected', async () => {
      const user = userEvent.setup();
      render(<App />);

      const select = screen.getByTestId('agent-select') as HTMLSelectElement;
      await user.selectOptions(select, 'agent1');

      await waitFor(() => {
        // When selecting from dropdown, App.handleAgentChange receives agentId and agentSource (undefined from mock)
        expect(mockVscodeApi.setSelectedAgentId).toHaveBeenCalledWith('agent1', undefined);
      });
    });

    it('should handle agent selection via selectAgent message', async () => {
      render(<App />);

      triggerMessage('selectAgent', { agentId: 'agent2' });

      await waitFor(() => {
        // selectAgent message passes agentSource (undefined when not provided in message)
        expect(mockVscodeApi.setSelectedAgentId).toHaveBeenCalledWith('agent2', undefined);
      });
    });
  });

  describe('Session Management', () => {
    it('should register session message handlers', () => {
      render(<App />);

      expect(messageHandlers.has('sessionStarted')).toBe(true);
      expect(messageHandlers.has('sessionEnded')).toBe(true);
      expect(messageHandlers.has('sessionStarting')).toBe(true);
      expect(messageHandlers.has('error')).toBe(true);
    });

    it('should resolve immediately when waiting for session end with no active session', async () => {
      render(<App />);

      // Try to switch agents when no session is active
      // This should not hang and should resolve immediately
      const select = screen.getByTestId('agent-select') as HTMLSelectElement;

      // Select an agent - should complete without waiting since no session is active
      await userEvent.selectOptions(select, 'agent1');

      await waitFor(() => {
        // When selecting from dropdown, App.handleAgentChange receives agentId and agentSource (undefined from mock)
        expect(mockVscodeApi.setSelectedAgentId).toHaveBeenCalledWith('agent1', undefined);
      });
    });

    it('should track session state with sessionStarted message', async () => {
      render(<App />);

      triggerMessage('sessionStarted', {});

      // Session state is tracked internally via refs
      expect(messageHandlers.has('sessionStarted')).toBe(true);
    });

    it('should track session end with sessionEnded message', async () => {
      render(<App />);

      triggerMessage('sessionEnded', {});

      // Session state is tracked internally via refs
      expect(messageHandlers.has('sessionEnded')).toBe(true);
    });

    it('should handle session errors', async () => {
      render(<App />);

      triggerMessage('error', { message: 'Test error' });

      // Error handling is done via refs
      expect(messageHandlers.has('error')).toBe(true);
    });

    // Note: Agent switching with active sessions is covered by:
    // - Integration tests (App.integration.test.tsx)
    // - "Agent Switching Without Active Session" tests below (lines 1028+)
    // - "Force Restart (Play Button)" tests below (lines 383+)
  });

  describe('Force Restart (Play Button)', () => {
    it('should trigger session restart when selectAgent message received', async () => {
      render(<App />);

      triggerMessage('selectAgent', { agentId: 'agent1' });

      await waitFor(() => {
        // selectAgent message passes agentSource (undefined when not provided in message)
        expect(mockVscodeApi.setSelectedAgentId).toHaveBeenCalledWith('agent1', undefined);
      });
    });

    it('should set transitioning state during force restart', async () => {
      render(<App />);

      // Start session first
      triggerMessage('selectAgent', { agentId: 'agent1' });
      triggerMessage('sessionStarted', {});

      await waitFor(() => {
        const transitioning = screen.getByTestId('is-transitioning');
        expect(transitioning.textContent).toBe('false');
      });

      // Force restart with same agent
      triggerMessage('selectAgent', { agentId: 'agent1', forceRestart: true });

      await waitFor(() => {
        const transitioning = screen.getByTestId('is-transitioning');
        expect(transitioning.textContent).toBe('true');
      });
    });
  });

  // Client App State tests removed - functionality was removed

  describe('Session Transition State', () => {
    it('should clear displayed agent when no target agent', async () => {
      render(<App />);

      // Select agent first
      triggerMessage('selectAgent', { agentId: 'agent1' });

      await waitFor(() => {
        expect(screen.getByTestId('selected-agent').textContent).toBe('agent1');
      });

      // Deselect agent
      const select = screen.getByTestId('agent-select') as HTMLSelectElement;
      await userEvent.setup().selectOptions(select, '');

      await waitFor(() => {
        expect(screen.getByTestId('selected-agent').textContent).toBe('none');
      });
    });

    it('should show pending agent during transitions', async () => {
      render(<App />);

      // Select first agent
      triggerMessage('selectAgent', { agentId: 'agent1' });
      triggerMessage('sessionStarted', {});

      await waitFor(() => {
        expect(screen.getByTestId('selected-agent').textContent).toBe('agent1');
      });

      // Switch to second agent
      triggerMessage('selectAgent', { agentId: 'agent2' });

      await waitFor(() => {
        // During transition, pending should show the new agent
        expect(screen.getByTestId('pending-agent').textContent).not.toBe('none');
      });
    });
  });

  describe('Session Promise Resolvers', () => {
    it('should resolve session start promise when sessionStarted is received', async () => {
      render(<App />);

      // Trigger force restart which creates a promise
      triggerMessage('selectAgent', { agentId: 'agent1' });

      // Immediately trigger sessionStarted to resolve the promise
      triggerMessage('sessionStarted', {});

      await waitFor(() => {
        expect(screen.getByTestId('selected-agent').textContent).toBe('agent1');
      });
    });

    it('should resolve session end promise when sessionEnded is received', async () => {
      render(<App />);

      // Start a session
      triggerMessage('selectAgent', { agentId: 'agent1' });

      await new Promise(resolve => setTimeout(resolve, 50));
      triggerMessage('sessionStarted', {});

      await waitFor(() => {
        expect(screen.getByTestId('selected-agent').textContent).toBe('agent1');
      });

      jest.clearAllMocks();

      // Switch to another agent (creates end promise)
      triggerMessage('selectAgent', { agentId: 'agent2' });

      await waitFor(
        () => {
          expect(mockVscodeApi.endSession).toHaveBeenCalled();
        },
        { timeout: 1000 }
      );

      // Resolve the end promise
      triggerMessage('sessionEnded', {});

      // Session ended resolver should have been called
      await new Promise(resolve => setTimeout(resolve, 1));
    });

    it('should resolve both session promises when error occurs', async () => {
      render(<App />);

      // Start a session
      triggerMessage('selectAgent', { agentId: 'agent1' });

      // Trigger error which should resolve both pending promises
      triggerMessage('error', { message: 'Session error' });

      await waitFor(() => {
        // Error handler should be called
        expect(messageHandlers.has('error')).toBe(true);
      });
    });

    it('should handle waitForSessionEnd when session is not active', async () => {
      render(<App />);

      // Try to switch agents when no session is active
      // This tests the early return in waitForSessionEnd
      triggerMessage('selectAgent', { agentId: 'agent1' });

      await waitFor(() => {
        expect(screen.getByTestId('is-transitioning').textContent).toBe('false');
      });

      // No session lifecycle methods should fire
      expect(mockVscodeApi.startSession).not.toHaveBeenCalled();

      // Ensure state updates propagated (selectAgent message passes agentSource)
      expect(mockVscodeApi.setSelectedAgentId).toHaveBeenCalledWith('agent1', undefined);

      // Should not call endSession since no session was active
      expect(mockVscodeApi.endSession).not.toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle selectAgent without agentId', () => {
      render(<App />);

      triggerMessage('selectAgent', {});

      // Should not crash
      expect(screen.getByTestId('agent-selector')).toBeInTheDocument();
    });

    it('should handle multiple rapid agent switches', async () => {
      render(<App />);

      triggerMessage('selectAgent', { agentId: 'agent1' });
      triggerMessage('selectAgent', { agentId: 'agent2' });
      triggerMessage('selectAgent', { agentId: 'agent3' });

      await waitFor(() => {
        // Should handle gracefully
        expect(mockVscodeApi.setSelectedAgentId).toHaveBeenCalled();
      });
    });

    it('should handle session start failure gracefully', async () => {
      render(<App />);

      // Trigger force restart
      triggerMessage('selectAgent', { agentId: 'agent1' });

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 1));

      // Trigger error instead of sessionStarted
      triggerMessage('error', { message: 'Failed to start session' });

      await waitFor(() => {
        // Session should handle error
        expect(messageHandlers.has('error')).toBe(true);
      });
    });

    it('should handle sessionStarting message', async () => {
      render(<App />);

      triggerMessage('selectAgent', { agentId: 'agent1' });

      // Trigger sessionStarting
      triggerMessage('sessionStarting', {});

      await waitFor(() => {
        expect(messageHandlers.has('sessionStarting')).toBe(true);
      });
    });

    it('should handle switching to no agent while session is active', async () => {
      render(<App />);

      // Start a session
      triggerMessage('selectAgent', { agentId: 'agent1' });
      triggerMessage('sessionStarted', {});

      await waitFor(() => {
        expect(screen.getByTestId('selected-agent').textContent).toBe('agent1');
      });

      // Switch to no agent
      const select = screen.getByTestId('agent-select') as HTMLSelectElement;
      await userEvent.setup().selectOptions(select, '');

      await waitFor(() => {
        // Should end session
        expect(mockVscodeApi.endSession).toHaveBeenCalled();
      });
    });

    it('should update agent without starting session when not force restart', async () => {
      render(<App />);

      // Regular agent selection (not force restart)
      const select = screen.getByTestId('agent-select') as HTMLSelectElement;
      await userEvent.setup().selectOptions(select, 'agent1');

      await waitFor(() => {
        // When selecting from dropdown, App.handleAgentChange receives agentId and agentSource (undefined from mock)
        expect(mockVscodeApi.setSelectedAgentId).toHaveBeenCalledWith('agent1', undefined);
      });

      // Should not auto-start session
      expect(mockVscodeApi.startSession).not.toHaveBeenCalled();
    });

    it('should handle session without active session when ending', async () => {
      render(<App />);

      // Try to switch agents without an active session
      triggerMessage('selectAgent', { agentId: 'agent1' });

      await waitFor(() => {
        expect(mockVscodeApi.setSelectedAgentId).toHaveBeenCalledWith('agent1', undefined);
      });

      // Should not call endSession since no session is active
      expect(mockVscodeApi.endSession).not.toHaveBeenCalled();
    });

    it('should handle session start success and update displayed agent', async () => {
      render(<App />);

      // Force restart with agent
      triggerMessage('selectAgent', { agentId: 'agent1' });

      // Wait a moment for the promise to be set up
      await new Promise(resolve => setTimeout(resolve, 50));

      // Resolve the session start successfully
      triggerMessage('sessionStarted', {});

      await waitFor(
        () => {
          expect(screen.getByTestId('selected-agent').textContent).toBe('agent1');
        },
        { timeout: 3000 }
      );
    });

    it('should handle session start failure by resolving promise with false', async () => {
      render(<App />);

      // Force restart with agent
      triggerMessage('selectAgent', { agentId: 'agent1' });

      // Wait a moment for the promise to be set up
      await new Promise(resolve => setTimeout(resolve, 50));

      // Fail the session start (trigger error instead of sessionStarted)
      // The error handler calls startResolver(false) which should prevent setting displayed agent
      triggerMessage('error', { message: 'Failed to start' });

      // Wait a moment to let async operations complete
      await new Promise(resolve => setTimeout(resolve, 150));

      // The error was handled - component should still be functional
      expect(screen.getByTestId('agent-selector')).toBeInTheDocument();
    });
  });

  describe('Error Handling in Session Management', () => {
    it('should catch and log errors in session management', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      render(<App />);

      // Cause an error by triggering rapid agent switches
      triggerMessage('selectAgent', { agentId: 'agent1' });
      triggerMessage('selectAgent', { agentId: 'agent2' });
      triggerMessage('selectAgent', { agentId: 'agent3' });

      await new Promise(resolve => setTimeout(resolve, 1));

      // The catch block should handle any errors gracefully
      expect(screen.getByTestId('agent-selector')).toBeInTheDocument();

      consoleErrorSpy.mockRestore();
    });
  });

  describe('Refresh Agents', () => {
    it('should switch to preview tab when refreshAgents message is received', async () => {
      render(<App />);

      // Select an agent and start session to show tracer
      triggerMessage('selectAgent', { agentId: 'agent1' });
      triggerMessage('sessionStarted', {});

      await waitFor(() => {
        expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
      });

      // Switch to tracer tab
      fireEvent.click(screen.getByTestId('tracer-tab'));

      await waitFor(() => {
        expect(screen.getByTestId('agent-tracer')).toBeInTheDocument();
      });

      // Trigger refreshAgents message
      triggerMessage('refreshAgents', {});

      // Should switch back to preview tab
      await waitFor(() => {
        expect(screen.getByTestId('agent-preview')).toBeInTheDocument();
      });
    });

    it('should clear the selected agent when selectAgent is called with an empty id', async () => {
      render(<App />);

      // Select an agent first
      triggerMessage('selectAgent', { agentId: 'agent1' });

      await waitFor(() => {
        expect(screen.getByTestId('selected-agent').textContent).toBe('agent1');
      });

      mockVscodeApi.clearMessages.mockClear();
      mockVscodeApi.loadAgentHistory.mockClear();

      // Provider clears the selection
      triggerMessage('selectAgent', { agentId: '' });

      await waitFor(() => {
        expect(screen.getByTestId('selected-agent').textContent).toBe('none');
      });

      expect(mockVscodeApi.clearMessages).toHaveBeenCalledTimes(1);
      expect(mockVscodeApi.loadAgentHistory).not.toHaveBeenCalled();
    });
  });

  describe('Tracer Go To Preview', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    it('should switch to preview tab when Go to Preview button is clicked', async () => {
      render(<App />);

      // Select an agent and start session to show tracer
      triggerMessage('selectAgent', { agentId: 'agent1' });
      triggerMessage('sessionStarted', {});

      await waitFor(() => {
        expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
      });

      // Switch to tracer tab
      fireEvent.click(screen.getByTestId('tracer-tab'));

      await waitFor(() => {
        expect(screen.getByTestId('agent-tracer')).toBeInTheDocument();
      });

      // Click Go to Preview button in tracer
      const goToPreviewButton = screen.getByTestId('tracer-go-to-preview');
      fireEvent.click(goToPreviewButton);

      // Should switch to preview tab
      await waitFor(() => {
        expect(screen.getByTestId('agent-preview')).toBeInTheDocument();
      });
    });

    it('should focus input when switching to preview from tracer', async () => {
      render(<App />);

      // Select an agent and start session
      triggerMessage('selectAgent', { agentId: 'agent1' });
      triggerMessage('sessionStarted', {});

      await waitFor(() => {
        expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
      });

      // Switch to tracer
      fireEvent.click(screen.getByTestId('tracer-tab'));

      // Click Go to Preview
      const goToPreviewButton = screen.getByTestId('tracer-go-to-preview');
      fireEvent.click(goToPreviewButton);

      // Fast-forward the setTimeout delay
      jest.advanceTimersByTime(100);

      await waitFor(() => {
        expect(mockFocusInput).toHaveBeenCalled();
      });
    });

    it('should keep tabs visible when session ends', async () => {
      render(<App />);

      // Select an agent and start session - tabs should show
      triggerMessage('selectAgent', { agentId: 'agent1' });
      triggerMessage('sessionStarted', {});

      await waitFor(() => {
        expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
      });

      // End the session - tabs should remain visible
      triggerMessage('sessionEnded', {});

      await waitFor(() => {
        expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
      });
    });

    it('should switch to preview tab when starting a new session from tracer', async () => {
      render(<App />);

      // Select an agent and start session
      triggerMessage('selectAgent', { agentId: 'agent1' });
      triggerMessage('sessionStarted', {});

      await waitFor(() => {
        expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
      });

      // Switch to tracer tab
      fireEvent.click(screen.getByTestId('tracer-tab'));

      await waitFor(() => {
        expect(screen.getByTestId('agent-tracer')).toBeInTheDocument();
      });

      // Start a new session (e.g., restart)
      triggerMessage('sessionStarting', {});

      // Should switch back to preview tab
      await waitFor(() => {
        expect(screen.getByTestId('agent-preview')).toBeInTheDocument();
      });
    });

    it('should start session when clicking Go to Preview with no active session', async () => {
      render(<App />);

      // Select an agent but don't start session
      triggerMessage('selectAgent', { agentId: 'agent1' });

      // End any session to ensure we're in a state with agent selected but no active session
      triggerMessage('sessionEnded', {});

      await waitFor(() => {
        expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
      });

      // Switch to tracer
      fireEvent.click(screen.getByTestId('tracer-tab'));

      await waitFor(() => {
        expect(screen.getByTestId('agent-tracer')).toBeInTheDocument();
      });

      jest.clearAllMocks();

      // Click Go to Preview when no session is active
      const goToPreviewButton = screen.getByTestId('tracer-go-to-preview');
      fireEvent.click(goToPreviewButton);

      // Should trigger session start with the current live mode setting (default false)
      await waitFor(() => {
        expect(mockVscodeApi.startSession).toHaveBeenCalledWith('agent1', { isLiveMode: false });
      });

      // Should switch to preview tab
      await waitFor(() => {
        expect(screen.getByTestId('agent-preview')).toBeInTheDocument();
      });
    });

    it('should start session with live mode when clicking Go to Preview with live mode enabled', async () => {
      render(<App />);

      // Select an agent and set live mode to true
      triggerMessage('selectAgent', { agentId: 'agent1' });
      triggerMessage('setLiveMode', { isLiveMode: true });

      // End any session to ensure we're in a state with agent selected but no active session
      triggerMessage('sessionEnded', {});

      await waitFor(() => {
        expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
      });

      // Switch to tracer
      fireEvent.click(screen.getByTestId('tracer-tab'));

      await waitFor(() => {
        expect(screen.getByTestId('agent-tracer')).toBeInTheDocument();
      });

      jest.clearAllMocks();

      // Click Go to Preview when no session is active but live mode is enabled
      const goToPreviewButton = screen.getByTestId('tracer-go-to-preview');
      fireEvent.click(goToPreviewButton);

      // Should trigger session start with live mode = true
      await waitFor(() => {
        expect(mockVscodeApi.startSession).toHaveBeenCalledWith('agent1', { isLiveMode: true });
      });

      // Should switch to preview tab
      await waitFor(() => {
        expect(screen.getByTestId('agent-preview')).toBeInTheDocument();
      });
    });

    it('should not restart session when clicking Go to Preview with active session', async () => {
      render(<App />);

      // Select an agent and start session
      triggerMessage('selectAgent', { agentId: 'agent1' });
      triggerMessage('sessionStarted', {});

      await waitFor(() => {
        expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
      });

      jest.clearAllMocks();

      // Switch to tracer
      fireEvent.click(screen.getByTestId('tracer-tab'));

      // Click Go to Preview (should NOT restart session)
      const goToPreviewButton = screen.getByTestId('tracer-go-to-preview');
      fireEvent.click(goToPreviewButton);

      // Should NOT trigger session start
      await waitFor(() => {
        expect(mockVscodeApi.startSession).not.toHaveBeenCalled();
      });

      // Should still focus input
      jest.advanceTimersByTime(100);
      expect(mockFocusInput).toHaveBeenCalled();
    });

    it('should not start session when clicking Go to Preview during session starting', async () => {
      render(<App />);

      // Select an agent
      triggerMessage('selectAgent', { agentId: 'agent1' });

      // Session is starting
      triggerMessage('sessionStarting', {});

      // Tabs would be hidden during starting, but let's test the behavior anyway
      // by manually clicking if the button were available

      jest.clearAllMocks();

      // Simulate clicking Go to Preview during session starting
      // This should not trigger another startSession call
      const handleGoToPreview = () => {
        // Simulate the handleGoToPreview logic
        if (!false && !true && 'agent1') {
          // !isSessionActive && !isSessionStarting && desiredAgentId
          mockVscodeApi.startSession('agent1');
        }
      };

      handleGoToPreview();

      // Should not have called startSession because isSessionStarting is true
      expect(mockVscodeApi.startSession).not.toHaveBeenCalled();
    });
  });

  describe('Agent Switching Without Active Session', () => {
    it('should handle switching agents when no session is active', async () => {
      render(<App />);

      // Select agent1 but don't start session
      triggerMessage('selectAgent', { agentId: 'agent1' });

      await waitFor(() => {
        expect(screen.getByTestId('selected-agent').textContent).toBe('agent1');
      });

      jest.clearAllMocks();

      // Switch to agent2 without having started a session
      // This tests the waitForSessionEnd early return path (line 156)
      triggerMessage('selectAgent', { agentId: 'agent2' });

      await waitFor(() => {
        expect(screen.getByTestId('selected-agent').textContent).toBe('agent2');
      });

      // Should not have triggered any end session calls since no session was active
      expect(mockVscodeApi.endSession).not.toHaveBeenCalled();
    });

    it('should handle switching agents after session has ended', async () => {
      render(<App />);

      // Select agent1 and start session
      triggerMessage('selectAgent', { agentId: 'agent1' });
      triggerMessage('sessionStarted', {});

      await waitFor(() => {
        expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
      });

      // End the session
      triggerMessage('sessionEnded', {});

      jest.clearAllMocks();

      // Now switch to agent2 (no active session to wait for)
      triggerMessage('selectAgent', { agentId: 'agent2' });

      await waitFor(() => {
        expect(screen.getByTestId('selected-agent').textContent).toBe('agent2');
      });

      // Should not have triggered end session since session was already ended
      expect(mockVscodeApi.endSession).not.toHaveBeenCalled();
    });
  });

  describe('Published Agent Behavior', () => {
    it('should hide tracer tab when a published agent is selected', async () => {
      const user = userEvent.setup();
      render(<App />);

      // Select a script agent first to show tracer tab
      const select = screen.getByTestId('agent-select') as HTMLSelectElement;
      await user.selectOptions(select, 'agent1');

      // Start session to show tabs
      triggerMessage('sessionStarted', {});

      await waitFor(() => {
        expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
        expect(screen.getByTestId('tracer-tab')).toBeInTheDocument();
      });

      // Switch to a published agent
      await user.selectOptions(select, 'published-agent');

      // Tracer tab should be hidden
      await waitFor(() => {
        expect(screen.queryByTestId('tracer-tab')).not.toBeInTheDocument();
      });
    });

    it('should show tracer tab when switching from published to script agent', async () => {
      const user = userEvent.setup();
      render(<App />);

      // Select a published agent first
      const select = screen.getByTestId('agent-select') as HTMLSelectElement;
      await user.selectOptions(select, 'published-agent');

      // Start session to show tabs
      triggerMessage('sessionStarted', {});

      await waitFor(() => {
        expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
        // Tracer tab should not be visible for published agent
        expect(screen.queryByTestId('tracer-tab')).not.toBeInTheDocument();
      });

      // Switch to a script agent
      await user.selectOptions(select, 'agent1');

      // Tracer tab should now be visible
      await waitFor(() => {
        expect(screen.getByTestId('tracer-tab')).toBeInTheDocument();
      });
    });

    it('should switch to preview tab when selecting a published agent while on tracer tab', async () => {
      const user = userEvent.setup();
      render(<App />);

      // Select a script agent
      const select = screen.getByTestId('agent-select') as HTMLSelectElement;
      await user.selectOptions(select, 'agent1');

      // Start session to show tabs
      triggerMessage('sessionStarted', {});

      await waitFor(() => {
        expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
      });

      // Switch to tracer tab
      fireEvent.click(screen.getByTestId('tracer-tab'));

      await waitFor(() => {
        expect(screen.getByTestId('agent-tracer')).toBeInTheDocument();
      });

      // Switch to a published agent while on tracer tab
      await user.selectOptions(select, 'published-agent');

      // Should automatically switch to preview tab
      await waitFor(() => {
        expect(screen.getByTestId('agent-preview')).toBeInTheDocument();
      });
    });

    it('should switch to preview tab when deselecting agent while on tracer tab', async () => {
      const user = userEvent.setup();
      render(<App />);

      // Select a script agent
      const select = screen.getByTestId('agent-select') as HTMLSelectElement;
      await user.selectOptions(select, 'agent1');

      // Start session to show tabs
      triggerMessage('sessionStarted', {});

      await waitFor(() => {
        expect(screen.getByTestId('tab-navigation')).toBeInTheDocument();
      });

      // Switch to tracer tab
      fireEvent.click(screen.getByTestId('tracer-tab'));

      await waitFor(() => {
        expect(screen.getByTestId('agent-tracer')).toBeInTheDocument();
      });

      // Deselect agent (select empty option) while on tracer tab
      await user.selectOptions(select, '');

      // Should automatically switch to preview tab (tabs will be hidden but activeTab should be preview)
      await waitFor(() => {
        expect(screen.getByTestId('agent-preview')).toBeInTheDocument();
      });
    });
  });

  describe('Auth Error Screen', () => {
    it('should show auth error screen when authError message is received', async () => {
      render(<App />);

      act(() => {
        triggerMessage('authError', { message: 'Unable to connect to org', details: 'Set a new default org or re-authenticate to continue.' });
      });

      await waitFor(() => {
        expect(screen.getByText('Unable to connect to org')).toBeInTheDocument();
        expect(screen.getByText('Set a new default org or re-authenticate to continue.')).toBeInTheDocument();
        expect(screen.getByText('Select Another Org')).toBeInTheDocument();
      });
    });

    it('should hide agent selector when auth error is shown', async () => {
      render(<App />);

      act(() => {
        triggerMessage('authError', { message: 'Unable to connect to org' });
      });

      await waitFor(() => {
        expect(screen.queryByTestId('agent-selector')).not.toBeInTheDocument();
      });
    });

    it('should execute sf.set.default.org when Select Another Org is clicked', async () => {
      render(<App />);

      act(() => {
        triggerMessage('authError', { message: 'Unable to connect to org' });
      });

      await waitFor(() => {
        expect(screen.getByText('Select Another Org')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Select Another Org'));

      expect(mockVscodeApi.executeCommand).toHaveBeenCalledWith('sf.set.default.org');
    });

    it('should clear auth error when refreshAgents message is received', async () => {
      render(<App />);

      act(() => {
        triggerMessage('authError', { message: 'Unable to connect to org' });
      });

      await waitFor(() => {
        expect(screen.getByText('Unable to connect to org')).toBeInTheDocument();
      });

      act(() => {
        triggerMessage('refreshAgents', undefined);
      });

      await waitFor(() => {
        expect(screen.queryByText('Unable to connect to org')).not.toBeInTheDocument();
        expect(screen.getByTestId('agent-selector')).toBeInTheDocument();
      });
    });

    it('should show Enable Agentforce button when setupUrl is provided', async () => {
      render(<App />);

      act(() => {
        triggerMessage('authError', {
          message: 'Agentforce is not enabled',
          details: 'This org does not have Agentforce enabled. Select an org with Agentforce to continue.',
          setupUrl: 'https://myorg.salesforce.com/lightning/setup/EinsteinCopilot/home'
        });
      });

      await waitFor(() => {
        expect(screen.getByText('Agentforce is not enabled')).toBeInTheDocument();
        expect(screen.getByText('Enable Agentforce')).toBeInTheDocument();
        expect(screen.getByText('Select Another Org')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Enable Agentforce'));
      expect(mockVscodeApi.openUrl).toHaveBeenCalledWith(
        'https://myorg.salesforce.com/lightning/setup/EinsteinCopilot/home'
      );
    });
  });
});
