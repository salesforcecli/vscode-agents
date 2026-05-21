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

import * as vscode from 'vscode';
import { AgentViewState } from '../../../../src/views/agentCombined/state/agentViewState';

// Mock VS Code
jest.mock('vscode', () => ({
  commands: {
    executeCommand: jest.fn()
  },
  Uri: {
    file: jest.fn((p: string) => ({ fsPath: p }))
  }
}));

describe('AgentViewState', () => {
  let state: AgentViewState;
  let mockContext: vscode.ExtensionContext;
  let mockWorkspaceState: { get: jest.Mock; update: jest.Mock };
  let mockGlobalState: { get: jest.Mock; update: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();

    mockWorkspaceState = {
      get: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined)
    };

    mockGlobalState = {
      get: jest.fn().mockReturnValue(false),
      update: jest.fn().mockResolvedValue(undefined)
    };

    mockContext = {
      workspaceState: mockWorkspaceState,
      globalState: mockGlobalState,
      subscriptions: []
    } as any;

    state = new AgentViewState(mockContext);
  });

  describe('export directory persistence', () => {
    it('should store export directory in workspaceState (per-workspace)', async () => {
      await state.setExportDirectory('/test/export/path');

      expect(mockWorkspaceState.update).toHaveBeenCalledWith(
        'agentforceDX.lastExportDirectory',
        '/test/export/path'
      );
    });

    it('should retrieve export directory from workspaceState', () => {
      mockWorkspaceState.get.mockReturnValue('/saved/workspace/path');

      const result = state.getExportDirectory();

      expect(mockWorkspaceState.get).toHaveBeenCalledWith('agentforceDX.lastExportDirectory');
      expect(result).toBe('/saved/workspace/path');
    });

    it('should return undefined when no export directory is saved', () => {
      mockWorkspaceState.get.mockReturnValue(undefined);

      const result = state.getExportDirectory();

      expect(result).toBeUndefined();
    });

    it('should use workspaceState not globalState for export directory', async () => {
      await state.setExportDirectory('/workspace/specific/path');

      // Verify workspaceState was used (per-workspace)
      expect(mockWorkspaceState.update).toHaveBeenCalled();
      // Verify globalState was NOT used for export directory
      expect(mockGlobalState.update).not.toHaveBeenCalledWith(
        'agentforceDX.lastExportDirectory',
        expect.anything()
      );
    });
  });

  describe('previewedSessionId', () => {
    it('flips agentforceDX:hasLoadedSession to true when set to a sessionId', () => {
      const executeCommand = vscode.commands.executeCommand as jest.Mock;
      executeCommand.mockClear();

      state.previewedSessionId = 'sess-123';

      expect(executeCommand).toHaveBeenCalledWith(
        'setContext',
        'agentforceDX:hasLoadedSession',
        true
      );
      expect(state.previewedSessionId).toBe('sess-123');
    });

    it('flips agentforceDX:hasLoadedSession to false when cleared', () => {
      state.previewedSessionId = 'sess-123';
      const executeCommand = vscode.commands.executeCommand as jest.Mock;
      executeCommand.mockClear();

      state.previewedSessionId = undefined;

      expect(executeCommand).toHaveBeenCalledWith(
        'setContext',
        'agentforceDX:hasLoadedSession',
        false
      );
      expect(state.previewedSessionId).toBeUndefined();
    });

    it('clearSessionState clears previewedSessionId', () => {
      state.previewedSessionId = 'sess-123';
      state.clearSessionState();
      expect(state.previewedSessionId).toBeUndefined();
    });
  });

  describe('hasAuthError', () => {
    it('defaults to false', () => {
      expect(state.hasAuthError).toBe(false);
    });

    it('tracks state when setAuthError is called with true', async () => {
      await state.setAuthError(true);

      expect(state.hasAuthError).toBe(true);
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'setContext',
        'agentforceDX:authError',
        true
      );
    });

    it('resets state when setAuthError is called with false', async () => {
      await state.setAuthError(true);
      await state.setAuthError(false);

      expect(state.hasAuthError).toBe(false);
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'setContext',
        'agentforceDX:authError',
        false
      );
    });
  });
});
