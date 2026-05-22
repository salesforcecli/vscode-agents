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

describe('vscodeApi', () => {
  let mockVSCodeApi: any;
  let vscodeApi: any;

  beforeEach(() => {
    // Reset modules to get a fresh instance
    jest.resetModules();

    // Create a mock VS Code API
    mockVSCodeApi = {
      postMessage: jest.fn(),
      getState: jest.fn(),
      setState: jest.fn()
    };

    // Set up the global window.vscode
    (window as any).vscode = mockVSCodeApi;

    // Import the service after setting up the mock
    const vscodeApiModule = require('../../../webview/src/services/vscodeApi');
    vscodeApi = vscodeApiModule.vscodeApi;
  });

  afterEach(() => {
    delete (window as any).vscode;
  });

  describe('Message Handling', () => {
    it('should register message handlers', () => {
      const handler = jest.fn();
      const dispose = vscodeApi.onMessage('testCommand', handler);

      expect(typeof dispose).toBe('function');
    });

    it('should invoke handler when message is received', () => {
      const handler = jest.fn();
      vscodeApi.onMessage('testCommand', handler);

      const messageData = { foo: 'bar' };
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { command: 'testCommand', data: messageData }
        })
      );

      expect(handler).toHaveBeenCalledWith(messageData);
    });

    it('should support multiple handlers for the same command', () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();

      vscodeApi.onMessage('testCommand', handler1);
      vscodeApi.onMessage('testCommand', handler2);

      const messageData = { test: 'data' };
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { command: 'testCommand', data: messageData }
        })
      );

      expect(handler1).toHaveBeenCalledWith(messageData);
      expect(handler2).toHaveBeenCalledWith(messageData);
    });

    it('should dispose handler when dispose function is called', () => {
      const handler = jest.fn();
      const dispose = vscodeApi.onMessage('testCommand', handler);

      dispose();

      window.dispatchEvent(
        new MessageEvent('message', {
          data: { command: 'testCommand', data: {} }
        })
      );

      expect(handler).not.toHaveBeenCalled();
    });

    it('should clean up handler set when last handler is disposed', () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();

      const dispose1 = vscodeApi.onMessage('testCommand', handler1);
      const dispose2 = vscodeApi.onMessage('testCommand', handler2);

      // Dispose both handlers
      dispose1();
      dispose2();

      // Message should not be handled
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { command: 'testCommand', data: { test: 'data' } }
        })
      );

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should not invoke handler for different command', () => {
      const handler = jest.fn();
      vscodeApi.onMessage('testCommand', handler);

      window.dispatchEvent(
        new MessageEvent('message', {
          data: { command: 'otherCommand', data: {} }
        })
      );

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('Session Management', () => {
    it('should send startSession message with agentId', () => {
      vscodeApi.startSession('agent123');

      expect(mockVSCodeApi.postMessage).toHaveBeenCalledWith({
        command: 'startSession',
        data: { agentId: 'agent123' }
      });
    });

    it('should send endSession message', () => {
      vscodeApi.endSession();

      expect(mockVSCodeApi.postMessage).toHaveBeenCalledWith({
        command: 'endSession',
        data: undefined
      });
    });

    it('should send sendChatMessage with message content', () => {
      vscodeApi.sendChatMessage('Hello, agent!');

      expect(mockVSCodeApi.postMessage).toHaveBeenCalledWith({
        command: 'sendChatMessage',
        data: { message: 'Hello, agent!' }
      });
    });
  });

  describe('Debug Mode', () => {
    it('should send setApexDebugging message when enabling debug mode', () => {
      vscodeApi.setApexDebugging(true);

      expect(mockVSCodeApi.postMessage).toHaveBeenCalledWith({
        command: 'setApexDebugging',
        data: true
      });
    });

    it('should send setApexDebugging message when disabling debug mode', () => {
      vscodeApi.setApexDebugging(false);

      expect(mockVSCodeApi.postMessage).toHaveBeenCalledWith({
        command: 'setApexDebugging',
        data: false
      });
    });
  });

  describe('Agent Management', () => {
    it('should send getAvailableAgents message', () => {
      vscodeApi.getAvailableAgents();

      expect(mockVSCodeApi.postMessage).toHaveBeenCalledWith({
        command: 'getAvailableAgents',
        data: undefined
      });
    });

    it('should send setSelectedAgentId message', () => {
      vscodeApi.setSelectedAgentId('agent456');

      expect(mockVSCodeApi.postMessage).toHaveBeenCalledWith({
        command: 'setSelectedAgentId',
        data: { agentId: 'agent456' }
      });
    });

    it('should send loadAgentHistory message', () => {
      vscodeApi.loadAgentHistory('agent789');

      expect(mockVSCodeApi.postMessage).toHaveBeenCalledWith({
        command: 'loadAgentHistory',
        data: { agentId: 'agent789' }
      });
    });
  });

  describe('Trace Utilities', () => {
    it('should send openTraceJson message with entry payload', () => {
      const entry = {
        storageKey: 'agent',
        agentId: 'agent',
        sessionId: 'session',
        planId: 'plan',
        trace: { foo: 'bar' }
      };

      vscodeApi.openTraceJson(entry);

      expect(mockVSCodeApi.postMessage).toHaveBeenCalledWith({
        command: 'openTraceJson',
        data: { entry }
      });
    });
  });

  describe('Configuration', () => {
    it('should send getConfiguration message with section', () => {
      vscodeApi.getConfiguration('salesforce.agentforceDX.someSetting');

      expect(mockVSCodeApi.postMessage).toHaveBeenCalledWith({
        command: 'getConfiguration',
        data: { section: 'salesforce.agentforceDX.someSetting' }
      });
    });
  });

  // Client App Selection methods were removed - tests deleted

  describe('Utility Methods', () => {
    it('should send clearChat message', () => {
      vscodeApi.clearChat();

      expect(mockVSCodeApi.postMessage).toHaveBeenCalledWith({
        command: 'clearChat',
        data: undefined
      });
    });

    it('should send clearMessages message', () => {
      vscodeApi.clearMessages();

      expect(mockVSCodeApi.postMessage).toHaveBeenCalledWith({
        command: 'clearMessages',
        data: undefined
      });
    });

    it('should send getTraceData message', () => {
      vscodeApi.getTraceData();

      expect(mockVSCodeApi.postMessage).toHaveBeenCalledWith({
        command: 'getTraceData',
        data: undefined
      });
    });

    it('should send executeCommand message', () => {
      vscodeApi.executeCommand('workbench.action.reloadWindow');

      expect(mockVSCodeApi.postMessage).toHaveBeenCalledWith({
        command: 'executeCommand',
        data: { commandId: 'workbench.action.reloadWindow', args: [] }
      });
    });

    it('should send openUrl message', () => {
      vscodeApi.openUrl('https://myorg.salesforce.com/lightning/setup/EinsteinCopilot/home');

      expect(mockVSCodeApi.postMessage).toHaveBeenCalledWith({
        command: 'openUrl',
        data: { url: 'https://myorg.salesforce.com/lightning/setup/EinsteinCopilot/home' }
      });
    });
  });
});
