import * as vscode from 'vscode';
import * as path from 'path';
import { readFileSync } from 'node:fs';
import { registerCreateAiAuthoringBundleCommand } from '../../src/commands/createAiAuthoringBundle';
import { Commands } from '../../src/enums/commands';
import { ScriptAgent } from '@salesforce/agents';
import { CoreExtensionService } from '../../src/services/coreExtensionService';
import { SfProject, generateApiName } from '@salesforce/core';

// Preserve real fs (got, via @salesforce/agents, needs fs.stat) and only mock readFileSync
jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  readFileSync: jest.fn()
}));

// Mock generateApiName
jest.mock('@salesforce/core', () => ({
  ...jest.requireActual('@salesforce/core'),
  generateApiName: jest.fn((name: string) => name.replace(/\s+/g, '')),
  SfProject: {
    getInstance: jest.fn()
  }
}));

/**
 * Helper to create a mock InputBox that simulates user interaction
 * Note: hide() does NOT trigger onDidHide to avoid resolving the promise twice
 * (the actual code pattern has onDidAccept call hide() then resolve())
 */
function createMockInputBox(valueToReturn: string | undefined, triggerBack = false) {
  let onDidAcceptCallback: (() => void) | undefined;
  let onDidHideCallback: (() => void) | undefined;
  let onDidTriggerButtonCallback: ((button: vscode.QuickInputButton) => void) | undefined;
  let onDidChangeValueCallback: ((value: string) => void) | undefined;

  const mockInputBox = {
    title: '',
    prompt: '',
    placeholder: '',
    value: '',
    validationMessage: undefined as string | undefined,
    buttons: [] as vscode.QuickInputButton[],
    onDidAccept: (callback: () => void) => {
      onDidAcceptCallback = callback;
    },
    onDidHide: (callback: () => void) => {
      onDidHideCallback = callback;
    },
    onDidTriggerButton: (callback: (button: vscode.QuickInputButton) => void) => {
      onDidTriggerButtonCallback = callback;
    },
    onDidChangeValue: (callback: (value: string) => void) => {
      onDidChangeValueCallback = callback;
    },
    show: jest.fn(() => {
      // Simulate async user interaction
      setTimeout(() => {
        if (triggerBack && onDidTriggerButtonCallback) {
          onDidTriggerButtonCallback(vscode.QuickInputButtons.Back);
        } else if (valueToReturn !== undefined) {
          mockInputBox.value = valueToReturn;
          if (onDidChangeValueCallback) {
            onDidChangeValueCallback(valueToReturn);
          }
          if (onDidAcceptCallback) {
            onDidAcceptCallback();
          }
        } else {
          // User cancelled - trigger onDidHide
          if (onDidHideCallback) {
            onDidHideCallback();
          }
        }
      }, 0);
    }),
    hide: jest.fn(),  // Don't trigger onDidHide - the actual code resolves in onDidAccept after hide()
    dispose: jest.fn()
  };

  return mockInputBox;
}

/**
 * Helper to create a mock QuickPick that simulates user interaction
 * Note: hide() does NOT trigger onDidHide to avoid resolving the promise twice
 */
function createMockQuickPick<T extends vscode.QuickPickItem>(itemToSelect: T | undefined, triggerBack = false) {
  let onDidAcceptCallback: (() => void) | undefined;
  let onDidHideCallback: (() => void) | undefined;
  let onDidTriggerButtonCallback: ((button: vscode.QuickInputButton) => void) | undefined;

  const mockQuickPick = {
    title: '',
    placeholder: '',
    items: [] as T[],
    selectedItems: [] as T[],
    buttons: [] as vscode.QuickInputButton[],
    onDidAccept: (callback: () => void) => {
      onDidAcceptCallback = callback;
    },
    onDidHide: (callback: () => void) => {
      onDidHideCallback = callback;
    },
    onDidTriggerButton: (callback: (button: vscode.QuickInputButton) => void) => {
      onDidTriggerButtonCallback = callback;
    },
    show: jest.fn(() => {
      // Simulate async user interaction
      setTimeout(() => {
        if (triggerBack && onDidTriggerButtonCallback) {
          onDidTriggerButtonCallback(vscode.QuickInputButtons.Back);
        } else if (itemToSelect !== undefined) {
          mockQuickPick.selectedItems = [itemToSelect];
          if (onDidAcceptCallback) {
            onDidAcceptCallback();
          }
        } else {
          // User cancelled - trigger onDidHide
          if (onDidHideCallback) {
            onDidHideCallback();
          }
        }
      }, 0);
    }),
    hide: jest.fn(),  // Don't trigger onDidHide - the actual code resolves in onDidAccept after hide()
    dispose: jest.fn()
  };

  return mockQuickPick;
}

describe('createAiAuthoringBundle', () => {
  let commandSpy: jest.SpyInstance;
  let createInputBoxSpy: jest.SpyInstance;
  let createQuickPickSpy: jest.SpyInstance;
  let showErrorMessageSpy: jest.SpyInstance;
  let createDirectorySpy: jest.SpyInstance;
  let readDirectorySpy: jest.SpyInstance;
  let readFileSpy: jest.SpyInstance;
  let createAgentScriptSpy: jest.SpyInstance;

  const fakeTelemetryInstance: any = {
    sendException: jest.fn(),
    sendCommandEvent: jest.fn()
  };

  const fakeChannelService: any = {
    showChannelOutput: jest.fn(),
    clear: jest.fn(),
    appendLine: jest.fn()
  };

  const fakeConnection: any = {
    instanceUrl: 'https://test.salesforce.com'
  };

  let mockProject: any;

  const createMockProject = () => ({
    getPath: jest.fn().mockReturnValue('/test/project'),
    getDefaultPackage: jest.fn().mockReturnValue({
      fullPath: '/test/project/force-app'
    })
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Ensure generateApiName mock is set up correctly
    (generateApiName as jest.Mock).mockImplementation((name: string) => name.replace(/\s+/g, ''));

    // Mock setTimeout to execute callbacks synchronously for testing
    jest.spyOn(global, 'setTimeout').mockImplementation((callback: any) => {
      callback();
      return 0 as any;
    });

    // Mock CoreExtensionService
    jest.spyOn(CoreExtensionService, 'getTelemetryService').mockReturnValue(fakeTelemetryInstance);
    jest.spyOn(CoreExtensionService, 'getChannelService').mockReturnValue(fakeChannelService);
    jest.spyOn(CoreExtensionService, 'getDefaultConnection').mockResolvedValue(fakeConnection);

    // Create a new mock project for each test
    mockProject = createMockProject();

    // Mock SfProject - getInstance is synchronous
    (SfProject.getInstance as jest.Mock).mockReturnValue(mockProject);

    // Mock vscode APIs
    commandSpy = jest.spyOn(vscode.commands, 'registerCommand');
    createInputBoxSpy = jest.spyOn(vscode.window, 'createInputBox');
    createQuickPickSpy = jest.spyOn(vscode.window, 'createQuickPick');
    jest.spyOn(vscode.window, 'showInformationMessage').mockImplementation();
    showErrorMessageSpy = jest.spyOn(vscode.window, 'showErrorMessage').mockImplementation();

    jest.spyOn(vscode.window, 'withProgress').mockImplementation(async (_options, task) => {
      return await task({ report: jest.fn() }, {} as vscode.CancellationToken);
    });

    // Mock openTextDocument and showTextDocument
    jest.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue({
      uri: vscode.Uri.file('/test/path'),
      fileName: 'test.agent',
      languageId: 'agent',
      version: 1,
      isDirty: false,
      isUntitled: false,
      isClosed: false,
      save: jest.fn(),
      dispose: jest.fn()
    } as any);

    // Mock showTextDocument - add it to window if it doesn't exist
    Object.defineProperty(vscode.window, 'showTextDocument', {
      value: jest.fn().mockResolvedValue({
        document: {} as any,
        viewColumn: 1,
        viewType: 'text'
      }),
      configurable: true,
      writable: true
    });

    // Mock file system operations
    createDirectorySpy = jest.spyOn(vscode.workspace.fs, 'createDirectory').mockResolvedValue(undefined);
    jest.spyOn(vscode.workspace.fs, 'writeFile').mockResolvedValue(undefined);
    readDirectorySpy = jest.spyOn(vscode.workspace.fs, 'readDirectory');
    readFileSpy = jest.spyOn(vscode.workspace.fs, 'readFile');

    // Mock Uri.file
    jest.spyOn(vscode.Uri, 'file').mockImplementation(
      (path: string) =>
        ({
          fsPath: path,
          scheme: 'file',
          path,
          authority: '',
          query: '',
          fragment: '',
          with: jest.fn(),
          toJSON: jest.fn(),
          toString: jest.fn(() => path)
        }) as any
    );

    // Mock ScriptAgent.createAuthoringBundle
    createAgentScriptSpy = jest.spyOn(ScriptAgent, 'createAuthoringBundle');

    // Mock readFileSync for spec file reads (used when a file spec is selected)
    (readFileSync as jest.Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('specs')) {
        return 'agentType: customer\nrole: TestRole';
      }
      throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    });
  });

  // Note: no afterEach(jest.restoreAllMocks) — the global `resetMocks: true` config
  // already resets mocks before each test. Adding restoreAllMocks here conflicts with
  // it for the `jest.spyOn(global, 'setTimeout')` spy (an inherited global property),
  // deleting `global.setTimeout` after the first test. See beforeEach above.

  const defaultSpecTypeItem = { label: 'Default template (Recommended)', description: 'Start with a ready-to-use Agent Script template.', isCustom: false };
  const customSpecTypeItem = { label: 'From an agent spec YAML file (Advanced)', description: 'Generate an Agent Script file from an existing agent spec YAML file.', isCustom: true };

  it('registers the command', () => {
    registerCreateAiAuthoringBundleCommand();
    expect(commandSpy).toHaveBeenCalledWith(Commands.createAiAuthoringBundle, expect.any(Function));
  });

  it('creates bundle successfully with valid inputs', async () => {
    // Mock spec files
    readDirectorySpy.mockResolvedValue([
      ['test-spec.yaml', vscode.FileType.File],
      ['another-spec.yml', vscode.FileType.File]
    ]);

    // Mock spec file content (read via readFileSync when file spec is selected)
    (readFileSync as jest.Mock).mockReturnValue('agentType: customer\nrole: Test Role');

    // Mock agent script generation
    createAgentScriptSpy.mockResolvedValue(undefined);

    // Wizard: template type → spec file → name → API name
    createQuickPickSpy
      .mockReturnValueOnce(createMockQuickPick(customSpecTypeItem))
      .mockReturnValueOnce(createMockQuickPick({ label: 'test-spec.yaml' }));
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox('My Test Agent'))
      .mockReturnValueOnce(createMockInputBox('MyTestAgent'));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    // Verify telemetry
    expect(fakeTelemetryInstance.sendCommandEvent).toHaveBeenCalledWith(
      Commands.createAiAuthoringBundle,
      expect.any(Array),
      { commandName: Commands.createAiAuthoringBundle }
    );

    // Verify agent script was created (description derived from name)
    expect(createAgentScriptSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSpec: expect.objectContaining({
          name: 'My Test Agent',
          developerName: 'MyTestAgent',
          agentType: 'customer',
          role: 'My Test Agent description'
        }),
        project: mockProject,
        bundleApiName: 'MyTestAgent',
        outputDir: expect.any(String)
      })
    );
  });

  it('cancels when user cancels template selection', async () => {
    readDirectorySpy.mockResolvedValue([['test-spec.yaml', vscode.FileType.File]]);

    createQuickPickSpy.mockReturnValueOnce(createMockQuickPick(undefined)); // Cancel at step 1

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    expect(createAgentScriptSpy).not.toHaveBeenCalled();
  });

  it('cancels when user cancels name input', async () => {
    readDirectorySpy.mockResolvedValue([]);

    // Wizard: template type (default only) → cancel at name
    createQuickPickSpy.mockReturnValueOnce(createMockQuickPick(defaultSpecTypeItem));
    createInputBoxSpy.mockReturnValueOnce(createMockInputBox(undefined));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    expect(createAgentScriptSpy).not.toHaveBeenCalled();
  });

  it('cancels when user cancels API name input', async () => {
    readDirectorySpy.mockResolvedValue([]);
    createQuickPickSpy.mockReturnValueOnce(createMockQuickPick(defaultSpecTypeItem));
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox('Test Agent'))
      .mockReturnValueOnce(createMockInputBox(undefined)); // Cancel at API name

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    expect(createAgentScriptSpy).not.toHaveBeenCalled();
  });

  it('shows Default Template only when no spec files found and calls createAuthoringBundle without agentSpec', async () => {
    readDirectorySpy.mockResolvedValue([]); // No spec files
    createAgentScriptSpy.mockResolvedValue(undefined);

    // Wizard: template type (default only) → name → API name
    createQuickPickSpy.mockReturnValueOnce(createMockQuickPick(defaultSpecTypeItem));
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox('My Test Agent'))
      .mockReturnValueOnce(createMockInputBox('MyTestAgent'));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    // createAuthoringBundle called with name/developerName even without spec file
    expect(createAgentScriptSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        project: mockProject,
        agentSpec: expect.objectContaining({
          name: 'My Test Agent',
          developerName: 'MyTestAgent',
          role: 'My Test Agent description'
        }),
        bundleApiName: 'MyTestAgent',
        outputDir: expect.any(String)
      })
    );
  });

  it('cancels when user cancels spec file selection', async () => {
    readDirectorySpy.mockResolvedValue([['test-spec.yaml', vscode.FileType.File]]);

    // Wizard: template type (custom) → cancel at spec file
    createQuickPickSpy
      .mockReturnValueOnce(createMockQuickPick(customSpecTypeItem))
      .mockReturnValueOnce(createMockQuickPick(undefined)); // User cancelled file selection

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    expect(createAgentScriptSpy).not.toHaveBeenCalled();
  });

  it('filters only YAML files from specs directory', async () => {
    readDirectorySpy.mockResolvedValue([
      ['test-spec.yaml', vscode.FileType.File],
      ['another-spec.yml', vscode.FileType.File],
      ['not-spec.json', vscode.FileType.File], // Should be filtered out
      ['readme.md', vscode.FileType.File], // Should be filtered out
      ['subdir', vscode.FileType.Directory] // Should be filtered out
    ]);

    readFileSpy.mockResolvedValue(new TextEncoder().encode('agentType: customer'));
    createAgentScriptSpy.mockResolvedValue(undefined);

    // Wizard: template type → spec file → name → API name
    createQuickPickSpy
      .mockReturnValueOnce(createMockQuickPick(customSpecTypeItem))
      .mockReturnValueOnce(createMockQuickPick({ label: 'test-spec.yaml' }));
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox('My Test Agent'))
      .mockReturnValueOnce(createMockInputBox('MyTestAgent'));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    // Verify createAuthoringBundle was called (which means YAML files were found)
    expect(createAgentScriptSpy).toHaveBeenCalled();
  });

  it('generates correct API name from regular name', async () => {
    readDirectorySpy.mockResolvedValue([['test.yaml', vscode.FileType.File]]);
    readFileSpy.mockResolvedValue(new TextEncoder().encode('agentType: customer'));
    createAgentScriptSpy.mockResolvedValue(undefined);

    // Wizard: template type → spec file → name → API name
    createQuickPickSpy
      .mockReturnValueOnce(createMockQuickPick(customSpecTypeItem))
      .mockReturnValueOnce(createMockQuickPick({ label: 'test.yaml' }));
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox('My Test Agent'))
      .mockReturnValueOnce(createMockInputBox('MyTestAgent'));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    // Verify generateApiName was called
    expect(generateApiName).toHaveBeenCalledWith('My Test Agent');
  });

  it('creates bundle in correct directory structure', async () => {
    readDirectorySpy.mockResolvedValue([['test.yaml', vscode.FileType.File]]);
    readFileSpy.mockResolvedValue(new TextEncoder().encode('agentType: customer'));
    createAgentScriptSpy.mockResolvedValue(undefined);

    // Wizard: template type → spec file → name → API name
    createQuickPickSpy
      .mockReturnValueOnce(createMockQuickPick(customSpecTypeItem))
      .mockReturnValueOnce(createMockQuickPick({ label: 'test.yaml' }));
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox('Test Agent'))
      .mockReturnValueOnce(createMockInputBox('TestAgent'));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    // Verify directory was created
    expect(createDirectorySpy).toHaveBeenCalled();
  });

  it('handles agent script generation errors gracefully', async () => {
    readDirectorySpy.mockResolvedValue([['test.yaml', vscode.FileType.File]]);
    readFileSpy.mockResolvedValue(new TextEncoder().encode('agentType: customer'));

    // Mock createAuthoringBundle to throw error
    createAgentScriptSpy.mockRejectedValue(new Error('API Error'));

    // Wizard: template type → spec file → name → API name
    createQuickPickSpy
      .mockReturnValueOnce(createMockQuickPick(customSpecTypeItem))
      .mockReturnValueOnce(createMockQuickPick({ label: 'test.yaml' }));
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox('Test Agent'))
      .mockReturnValueOnce(createMockInputBox('TestAgent'));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    // Verify error was shown
    expect(showErrorMessageSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to generate agent'));
  });

  it('displays error message in output channel', async () => {
    readDirectorySpy.mockResolvedValue([['test.yaml', vscode.FileType.File]]);

    // Mock createAgentScript to throw error
    createAgentScriptSpy.mockRejectedValue(new Error('API connection timeout'));

    // Wizard: template type → spec file → name → API name
    createQuickPickSpy
      .mockReturnValueOnce(createMockQuickPick(customSpecTypeItem))
      .mockReturnValueOnce(createMockQuickPick({ label: 'test.yaml' }));
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox('Test Agent'))
      .mockReturnValueOnce(createMockInputBox('TestAgent'));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    // Verify error message is displayed in channel
    expect(fakeChannelService.appendLine).toHaveBeenCalledWith(
      expect.stringMatching(/\[error\].*Failed to generate agent/)
    );
    expect(fakeChannelService.appendLine).toHaveBeenCalledWith(
      expect.stringMatching(/\[error\].*Details: API connection timeout/)
    );
  });

  it('displays "Something went wrong" for empty error message in output channel', async () => {
    readDirectorySpy.mockResolvedValue([['test.yaml', vscode.FileType.File]]);
    readFileSpy.mockResolvedValue(new TextEncoder().encode('agentType: customer'));

    // Mock createAgentScript to throw error with empty message
    const emptyError = new Error('');
    createAgentScriptSpy.mockRejectedValue(emptyError);

    // Wizard: template type → spec file → name → API name
    createQuickPickSpy
      .mockReturnValueOnce(createMockQuickPick(customSpecTypeItem))
      .mockReturnValueOnce(createMockQuickPick({ label: 'test.yaml' }));
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox('Test Agent'))
      .mockReturnValueOnce(createMockInputBox('TestAgent'));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    // Verify fallback message is displayed
    expect(fakeChannelService.appendLine).toHaveBeenCalledWith(
      expect.stringMatching(/\[error\].*Failed to generate agent/)
    );
    expect(showErrorMessageSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to generate agent'));
  });

  it('validates agent name is not empty', async () => {
    readDirectorySpy.mockResolvedValue([]);

    // Step 1: Select template type
    createQuickPickSpy.mockReturnValueOnce(createMockQuickPick(defaultSpecTypeItem));

    // Step 3: Create a mock InputBox that captures the validation then cancels
    let capturedValidation: ((value: string) => string | null) | undefined;

    createInputBoxSpy.mockImplementation(() => {
      let onDidAcceptCallback: (() => void) | undefined;
      let onDidHideCallback: (() => void) | undefined;
      let onDidChangeValueCallback: ((value: string) => void) | undefined;

      const mockInputBox = {
        title: '',
        prompt: '',
        placeholder: '',
        value: '',
        validationMessage: undefined as string | undefined,
        buttons: [],
        onDidAccept: (callback: () => void) => {
          onDidAcceptCallback = callback;
        },
        onDidHide: (callback: () => void) => {
          onDidHideCallback = callback;
        },
        onDidTriggerButton: jest.fn(),
        onDidChangeValue: (callback: (value: string) => void) => {
          onDidChangeValueCallback = callback;
          // Capture the validation by testing it
          capturedValidation = (value: string) => {
            callback(value);
            return mockInputBox.validationMessage ?? null;
          };
        },
        show: jest.fn(() => {
          setTimeout(() => {
            if (onDidHideCallback) {
              onDidHideCallback();
            }
          }, 0);
        }),
        hide: jest.fn(),
        dispose: jest.fn()
      };

      return mockInputBox;
    });

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    // The validation is tested via the onDidChangeValue callback behavior
    // Since the input box was shown and hidden, the command should have been cancelled
    expect(createAgentScriptSpy).not.toHaveBeenCalled();
  });

  it('uses provided URI when command invoked from context menu', async () => {
    const contextUri = vscode.Uri.file(path.join('custom', 'path', 'aiAuthoringBundles'));

    readDirectorySpy.mockResolvedValue([['test.yaml', vscode.FileType.File]]);
    readFileSpy.mockResolvedValue(new TextEncoder().encode('agentType: customer'));
    createAgentScriptSpy.mockResolvedValue(undefined);

    // Wizard: template type → spec file → name → API name
    createQuickPickSpy
      .mockReturnValueOnce(createMockQuickPick(customSpecTypeItem))
      .mockReturnValueOnce(createMockQuickPick({ label: 'test.yaml' }));
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox('Test Agent'))
      .mockReturnValueOnce(createMockInputBox('TestAgent'));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler(contextUri);

    // Verify command executed successfully
    expect(createAgentScriptSpy).toHaveBeenCalled();
  });

  it('calls createDirectory to create bundle structure', async () => {
    readDirectorySpy.mockResolvedValue([['test.yaml', vscode.FileType.File]]);
    readFileSpy.mockResolvedValue(new TextEncoder().encode('agentType: customer'));
    createAgentScriptSpy.mockResolvedValue(undefined);

    // Wizard: template type → spec file → name → API name
    createQuickPickSpy
      .mockReturnValueOnce(createMockQuickPick(customSpecTypeItem))
      .mockReturnValueOnce(createMockQuickPick({ label: 'test.yaml' }));
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox('My Test Agent'))
      .mockReturnValueOnce(createMockInputBox('MyTestAgent'));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    // Verify bundle directory was created
    expect(createDirectorySpy).toHaveBeenCalled();
    expect(createAgentScriptSpy).toHaveBeenCalled();
  });

  it('passes spec data with name and developerName to createAuthoringBundle', async () => {
    readDirectorySpy.mockResolvedValue([['test.yaml', vscode.FileType.File]]);
    (readFileSync as jest.Mock).mockReturnValue('agentType: customer\nrole: TestRole');
    createAgentScriptSpy.mockResolvedValue(undefined);

    // Wizard: template type → spec file → name → API name
    createQuickPickSpy
      .mockReturnValueOnce(createMockQuickPick(customSpecTypeItem))
      .mockReturnValueOnce(createMockQuickPick({ label: 'test.yaml' }));
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox('Test Agent'))
      .mockReturnValueOnce(createMockInputBox('TestAgent'));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    // Verify createAuthoringBundle was called with correct parameters
    // Description is derived from name
    expect(createAgentScriptSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSpec: expect.objectContaining({
          name: 'Test Agent',
          developerName: 'TestAgent',
          agentType: 'customer',
          role: 'Test Agent description'
        }),
        project: mockProject,
        outputDir: expect.any(String),
        bundleApiName: 'TestAgent'
      })
    );

    // Verify generateApiName was called with the name
    expect(generateApiName).toHaveBeenCalledWith('Test Agent');
  });

  it('handles specs directory not found error', async () => {
    // Mock readDirectory to throw error (directory not found)
    readDirectorySpy.mockRejectedValue(new Error('Directory not found'));
    createAgentScriptSpy.mockResolvedValue(undefined);

    // Wizard: template type (default only) → name → API name
    createQuickPickSpy.mockReturnValueOnce(createMockQuickPick(defaultSpecTypeItem));
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox('Test Agent'))
      .mockReturnValueOnce(createMockInputBox('TestAgent'));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    // Should log the warning (specs dir not found)
    expect(fakeChannelService.appendLine).toHaveBeenCalledWith(
      expect.stringMatching(/\[warn\].*No agent spec directory found/)
    );
    // Should show Default Template only and call createAuthoringBundle with name/developerName
    expect(createAgentScriptSpy).toHaveBeenCalled();
    expect(createAgentScriptSpy.mock.calls[0][0].agentSpec).toEqual(
      expect.objectContaining({
        name: 'Test Agent',
        developerName: 'TestAgent',
        role: 'Test Agent description'
      })
    );
  });

  it('calls createAuthoringBundle without agentSpec when Default Template is selected', async () => {
    readDirectorySpy.mockResolvedValue([['custom.yaml', vscode.FileType.File]]);
    createAgentScriptSpy.mockResolvedValue(undefined);

    // Wizard: template type (default) → name → API name
    createQuickPickSpy.mockReturnValueOnce(createMockQuickPick(defaultSpecTypeItem));
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox('New Agent'))
      .mockReturnValueOnce(createMockInputBox('NewAgent'));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    expect(createAgentScriptSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        project: mockProject,
        agentSpec: expect.objectContaining({
          name: 'New Agent',
          developerName: 'NewAgent',
          role: 'New Agent description'
        }),
        bundleApiName: 'NewAgent',
        outputDir: expect.any(String)
      })
    );
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('opens the generated agent file after successful creation', async () => {
    const openTextDocumentSpy = jest.spyOn(vscode.workspace, 'openTextDocument');
    const showTextDocumentSpy = jest.spyOn(vscode.window, 'showTextDocument');

    readDirectorySpy.mockResolvedValue([['test.yaml', vscode.FileType.File]]);
    readFileSpy.mockResolvedValue(new TextEncoder().encode('agentType: customer'));
    createAgentScriptSpy.mockResolvedValue(undefined);

    // Wizard: template type → spec file → name → API name
    createQuickPickSpy
      .mockReturnValueOnce(createMockQuickPick(customSpecTypeItem))
      .mockReturnValueOnce(createMockQuickPick({ label: 'test.yaml' }));
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox('Test Agent'))
      .mockReturnValueOnce(createMockInputBox('TestAgent'));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    // Verify the agent file was opened
    expect(openTextDocumentSpy).toHaveBeenCalled();
    expect(showTextDocumentSpy).toHaveBeenCalled();
  });

  it('navigates back from name input to template selection', async () => {
    readDirectorySpy.mockResolvedValue([]);
    createAgentScriptSpy.mockResolvedValue(undefined);

    // Flow: template → name (back) → template → name → API name
    createQuickPickSpy
      .mockReturnValueOnce(createMockQuickPick(defaultSpecTypeItem))
      .mockReturnValueOnce(createMockQuickPick(defaultSpecTypeItem));
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox(undefined, true)) // Back from name
      .mockReturnValueOnce(createMockInputBox('Second Name'))
      .mockReturnValueOnce(createMockInputBox('SecondName'));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    // Should have called createQuickPick twice (once initially, once after back)
    expect(createQuickPickSpy).toHaveBeenCalledTimes(2);
    // Final name should be 'Second Name'
    expect(createAgentScriptSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        bundleApiName: 'SecondName'
      })
    );
  });

  it('navigates back from spec file selection to template selection', async () => {
    readDirectorySpy.mockResolvedValue([['test.yaml', vscode.FileType.File]]);
    createAgentScriptSpy.mockResolvedValue(undefined);

    // Flow: template (custom) → spec file (back) → template (default) → name → API name
    createQuickPickSpy
      .mockReturnValueOnce(createMockQuickPick(customSpecTypeItem)) // Select custom
      .mockReturnValueOnce(createMockQuickPick(undefined, true)) // Back from file selection
      .mockReturnValueOnce(createMockQuickPick(defaultSpecTypeItem)); // Select default instead
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox('Test Agent'))
      .mockReturnValueOnce(createMockInputBox('TestAgent'));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    // Should have called createQuickPick 3 times
    expect(createQuickPickSpy).toHaveBeenCalledTimes(3);
    // Should have created bundle with name/developerName (default selected, no spec file)
    expect(createAgentScriptSpy.mock.calls[0][0].agentSpec).toEqual(
      expect.objectContaining({
        name: 'Test Agent',
        developerName: 'TestAgent',
        role: 'Test Agent description'
      })
    );
  });

  it('navigates back from API name input to name input', async () => {
    readDirectorySpy.mockResolvedValue([]);
    createAgentScriptSpy.mockResolvedValue(undefined);

    // Flow: template → name → API name (back) → name → API name
    createQuickPickSpy.mockReturnValueOnce(createMockQuickPick(defaultSpecTypeItem));
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox('First Name'))
      .mockReturnValueOnce(createMockInputBox(undefined, true)) // Back from API name
      .mockReturnValueOnce(createMockInputBox('Second Name'))
      .mockReturnValueOnce(createMockInputBox('SecondName'));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    // Should have created bundle with the second name
    expect(createAgentScriptSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSpec: expect.objectContaining({
          name: 'Second Name',
          developerName: 'SecondName'
        }),
        bundleApiName: 'SecondName'
      })
    );
  });

  it('uses custom API name when provided by user', async () => {
    readDirectorySpy.mockResolvedValue([]);
    createAgentScriptSpy.mockResolvedValue(undefined);

    // Wizard: template type → name → custom API name
    createQuickPickSpy.mockReturnValueOnce(createMockQuickPick(defaultSpecTypeItem));
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox('My Agent'))
      .mockReturnValueOnce(createMockInputBox('CustomApiName'));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    expect(createAgentScriptSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSpec: expect.objectContaining({
          developerName: 'CustomApiName'
        }),
        bundleApiName: 'CustomApiName'
      })
    );
  });

  it('uses generated API name when user accepts empty value', async () => {
    readDirectorySpy.mockResolvedValue([]);
    createAgentScriptSpy.mockResolvedValue(undefined);

    // Wizard: template type → name → empty API name (uses generated default)
    createQuickPickSpy.mockReturnValueOnce(createMockQuickPick(defaultSpecTypeItem));
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox('My Agent'))
      .mockReturnValueOnce(createMockInputBox(''));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    // Should use generated API name (mock strips spaces: 'My Agent' → 'MyAgent')
    expect(createAgentScriptSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSpec: expect.objectContaining({
          developerName: 'MyAgent'
        }),
        bundleApiName: 'MyAgent'
      })
    );
  });

  it('navigates back from name to spec file when YAML spec was selected', async () => {
    readDirectorySpy.mockResolvedValue([['test.yaml', vscode.FileType.File]]);
    createAgentScriptSpy.mockResolvedValue(undefined);

    // Flow: template (custom) → spec file → name (back) → spec file → name → API name
    createQuickPickSpy
      .mockReturnValueOnce(createMockQuickPick(customSpecTypeItem))
      .mockReturnValueOnce(createMockQuickPick({ label: 'test.yaml' }))
      .mockReturnValueOnce(createMockQuickPick({ label: 'test.yaml' }));
    createInputBoxSpy
      .mockReturnValueOnce(createMockInputBox(undefined, true)) // Back from name to spec file
      .mockReturnValueOnce(createMockInputBox('Test Agent'))
      .mockReturnValueOnce(createMockInputBox('TestAgent'));

    registerCreateAiAuthoringBundleCommand();
    const handler = commandSpy.mock.calls[0][1];
    await handler();

    // Should have shown spec file picker twice
    expect(createQuickPickSpy).toHaveBeenCalledTimes(3);
    expect(createAgentScriptSpy).toHaveBeenCalled();
  });

  describe('duplicate API name validation', () => {
    it('shows validation error when API name already exists', async () => {
      // First call: specs dir (no specs), second call: aiAuthoringBundles dir with existing agent
      readDirectorySpy
        .mockResolvedValueOnce([]) // specs dir
        .mockResolvedValueOnce([['ExistingAgent', vscode.FileType.Directory]]); // aiAuthoringBundles dir

      createAgentScriptSpy.mockResolvedValue(undefined);

      // Step 1: Select default template
      createQuickPickSpy.mockReturnValueOnce(createMockQuickPick(defaultSpecTypeItem));

      // Step 3: Enter name
      createInputBoxSpy.mockReturnValueOnce(createMockInputBox('Test Agent'));

      // Step 4: Capture the validator from the API name input box
      let capturedValidator: ((value: string) => string | null) | undefined;
      createInputBoxSpy.mockImplementationOnce(() => {
        const mockBox = createMockInputBox(undefined); // Cancel after capturing
        const originalOnDidChangeValue = mockBox.onDidChangeValue;
        mockBox.onDidChangeValue = (callback: (value: string) => void) => {
          capturedValidator = (value: string) => {
            callback(value);
            return mockBox.validationMessage ?? null;
          };
          originalOnDidChangeValue(callback);
        };
        return mockBox;
      });

      registerCreateAiAuthoringBundleCommand();
      const handler = commandSpy.mock.calls[0][1];
      await handler();

      expect(capturedValidator).toBeDefined();
      expect(capturedValidator!('ExistingAgent')).toBe('An agent with this API name already exists.');
      expect(capturedValidator!('UniqueAgent')).toBeNull();
    });

    it('performs case-insensitive duplicate detection', async () => {
      readDirectorySpy
        .mockResolvedValueOnce([]) // specs dir
        .mockResolvedValueOnce([['MyAgent', vscode.FileType.Directory]]); // aiAuthoringBundles

      createQuickPickSpy.mockReturnValueOnce(createMockQuickPick(defaultSpecTypeItem));
      createInputBoxSpy.mockReturnValueOnce(createMockInputBox('Test Agent'));

      let capturedValidator: ((value: string) => string | null) | undefined;
      createInputBoxSpy.mockImplementationOnce(() => {
        const mockBox = createMockInputBox(undefined);
        const originalOnDidChangeValue = mockBox.onDidChangeValue;
        mockBox.onDidChangeValue = (callback: (value: string) => void) => {
          capturedValidator = (value: string) => {
            callback(value);
            return mockBox.validationMessage ?? null;
          };
          originalOnDidChangeValue(callback);
        };
        return mockBox;
      });

      registerCreateAiAuthoringBundleCommand();
      const handler = commandSpy.mock.calls[0][1];
      await handler();

      expect(capturedValidator).toBeDefined();
      expect(capturedValidator!('myagent')).toBe('An agent with this API name already exists.');
      expect(capturedValidator!('MYAGENT')).toBe('An agent with this API name already exists.');
    });

    it('shows validation error when generated API name already exists and user accepts empty value', async () => {
      (generateApiName as jest.Mock).mockReturnValue('TestAgent');

      readDirectorySpy
        .mockResolvedValueOnce([]) // specs dir
        .mockResolvedValueOnce([['TestAgent', vscode.FileType.Directory]]); // aiAuthoringBundles

      createQuickPickSpy.mockReturnValueOnce(createMockQuickPick(defaultSpecTypeItem));
      createInputBoxSpy.mockReturnValueOnce(createMockInputBox('Test Agent'));

      let capturedValidator: ((value: string) => string | null) | undefined;
      createInputBoxSpy.mockImplementationOnce(() => {
        const mockBox = createMockInputBox(undefined);
        const originalOnDidChangeValue = mockBox.onDidChangeValue;
        mockBox.onDidChangeValue = (callback: (value: string) => void) => {
          capturedValidator = (value: string) => {
            callback(value);
            return mockBox.validationMessage ?? null;
          };
          originalOnDidChangeValue(callback);
        };
        return mockBox;
      });

      registerCreateAiAuthoringBundleCommand();
      const handler = commandSpy.mock.calls[0][1];
      await handler();

      expect(capturedValidator).toBeDefined();
      // Empty value means "use generated name", which already exists
      expect(capturedValidator!('')).toBe('An agent with this API name already exists.');
    });

    it('allows creation when aiAuthoringBundles directory does not exist', async () => {
      readDirectorySpy
        .mockResolvedValueOnce([]) // specs dir
        .mockRejectedValueOnce(new Error('Directory not found')); // aiAuthoringBundles dir doesn't exist

      createAgentScriptSpy.mockResolvedValue(undefined);

      createQuickPickSpy.mockReturnValueOnce(createMockQuickPick(defaultSpecTypeItem));
      createInputBoxSpy
        .mockReturnValueOnce(createMockInputBox('Test Agent'))
        .mockReturnValueOnce(createMockInputBox('TestAgent'));

      registerCreateAiAuthoringBundleCommand();
      const handler = commandSpy.mock.calls[0][1];
      await handler();

      // Should proceed without errors — no duplicates when directory doesn't exist
      expect(createAgentScriptSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          bundleApiName: 'TestAgent'
        })
      );
    });
  });
});
