import * as vscode from 'vscode';
import * as path from 'path';
import * as YAML from 'yaml';
import { Commands } from '../enums/commands';
import { AgentJobSpec, ScriptAgent } from '@salesforce/agents';
import { CoreExtensionService } from '../services/coreExtensionService';
import { SfProject, generateApiName, SfError } from '@salesforce/core';
import { Logger } from '../utils/logger';
import { readFileSync } from 'node:fs';

type SpecTypePickItem = vscode.QuickPickItem & { isCustom: boolean };

/**
 * Shows a QuickPick with optional back button support
 * Returns the selected item, 'back' if back was pressed, or undefined if cancelled
 */
async function showQuickPickWithBack<T extends vscode.QuickPickItem>(
  items: T[],
  options: { title: string; placeholder: string; showBack: boolean }
): Promise<T | 'back' | undefined> {
  return new Promise(resolve => {
    const quickPick = vscode.window.createQuickPick<T>();
    quickPick.items = items;
    quickPick.title = options.title;
    quickPick.placeholder = options.placeholder;

    if (options.showBack) {
      quickPick.buttons = [vscode.QuickInputButtons.Back];
    }

    quickPick.onDidTriggerButton(button => {
      if (button === vscode.QuickInputButtons.Back) {
        quickPick.hide();
        resolve('back');
      }
    });

    quickPick.onDidAccept(() => {
      const selection = quickPick.selectedItems[0];
      quickPick.hide();
      resolve(selection);
    });

    quickPick.onDidHide(() => {
      quickPick.dispose();
      resolve(undefined);
    });

    quickPick.show();
  });
}

/**
 * Shows an InputBox with optional back button support
 * Returns the input value, 'back' if back was pressed, or undefined if cancelled
 */
async function showInputBoxWithBack(options: {
  title: string;
  prompt: string;
  placeholder: string;
  value?: string;
  showBack: boolean;
  validateInput?: (value: string) => string | null;
}): Promise<string | 'back' | undefined> {
  return new Promise(resolve => {
    const inputBox = vscode.window.createInputBox();
    inputBox.title = options.title;
    inputBox.prompt = options.prompt;
    inputBox.placeholder = options.placeholder;
    inputBox.value = options.value ?? '';

    if (options.showBack) {
      inputBox.buttons = [vscode.QuickInputButtons.Back];
    }

    if (options.validateInput) {
      inputBox.onDidChangeValue(value => {
        inputBox.validationMessage = options.validateInput!(value) ?? undefined;
      });
    }

    inputBox.onDidTriggerButton(button => {
      if (button === vscode.QuickInputButtons.Back) {
        inputBox.hide();
        resolve('back');
      }
    });

    inputBox.onDidAccept(() => {
      if (options.validateInput) {
        const error = options.validateInput(inputBox.value);
        if (error) {
          inputBox.validationMessage = error;
          return;
        }
      }
      const value = inputBox.value;
      inputBox.hide();
      resolve(value);
    });

    inputBox.onDidHide(() => {
      inputBox.dispose();
      resolve(undefined);
    });

    inputBox.show();
  });
}

export const registerCreateAiAuthoringBundleCommand = () => {
  return vscode.commands.registerCommand(Commands.createAiAuthoringBundle, async (uri?: vscode.Uri) => {
    const telemetryService = CoreExtensionService.getTelemetryService();
    const logger = new Logger(CoreExtensionService.getChannelService());
    const commandName = Commands.createAiAuthoringBundle;
    const hrstart = process.hrtime();
    telemetryService?.sendCommandEvent(commandName, hrstart, { commandName });

    // Clear previous output
    logger.clear();

    try {
      // Get the project root
      const project = SfProject.getInstance();
      const projectRoot = project.getPath();

      // Determine the target directory
      // Agent.createAuthoringBundle appends 'aiAuthoringBundles' to outputDir,
      // so we need to pass the parent directory (main/default) not the full path
      let targetDir: string;
      if (uri?.fsPath) {
        // If uri points to aiAuthoringBundles, go up one level
        if (uri.fsPath.endsWith('aiAuthoringBundles')) {
          targetDir = path.dirname(uri.fsPath);
        } else {
          targetDir = uri.fsPath;
        }
      } else {
        // Default to the proper metadata directory structure (main/default, not including aiAuthoringBundles)
        const defaultPackagePath = project.getDefaultPackage().fullPath;
        targetDir = path.join(defaultPackagePath, 'main', 'default');
      }

      // Create the aiAuthoringBundles directory if it doesn't exist
      const aiAuthoringBundlesDir = path.join(targetDir, 'aiAuthoringBundles');
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(aiAuthoringBundlesDir));
      } catch {
        // Directory might already exist, which is fine
      }

      // Look for spec files in the specs directory (at project root)
      const specsDir = path.join(projectRoot, 'specs');
      let specFiles: string[] = [];

      try {
        const specDirUri = vscode.Uri.file(specsDir);
        const files = await vscode.workspace.fs.readDirectory(specDirUri);
        specFiles = files
          .filter(
            ([fileName, type]) =>
              type === vscode.FileType.File &&
              (fileName.endsWith('.yaml') || fileName.endsWith('.yml')) &&
              !fileName.includes('-testSpec')
          )
          .map(([fileName]) => fileName);
      } catch {
        logger.warn(`No agent spec directory found at ${specsDir}.`);
      }

      const specTypeItems: SpecTypePickItem[] = [
        {
          label: 'Default template (Recommended)',
          description: 'Start with a ready-to-use Agent Script template.',
          isCustom: false
        },
        ...(specFiles.length > 0
          ? [
              {
                label: 'From an agent spec YAML file (Advanced)',
                description: 'Generate an Agent Script file from an existing agent spec YAML file.',
                isCustom: true
              }
            ]
          : [])
      ];

      // Multi-step wizard with back navigation
      let step = 1;
      let name: string | undefined;
      let apiName: string | undefined;
      let selectedType: SpecTypePickItem | undefined;
      let spec: string | undefined;

      while (step > 0) {
        if (step === 1) {
          // Step 1: Select template type
          const result = await showQuickPickWithBack(specTypeItems, {
            title: 'Create Agent',
            placeholder: 'Select an agent template',
            showBack: false
          });

          if (result === undefined) {
            return; // User cancelled
          }
          selectedType = result as SpecTypePickItem;

          if (selectedType.isCustom) {
            step = 2;
          } else {
            spec = undefined;
            step = 3; // Skip to name input
          }
        } else if (step === 2) {
          // Step 2: Select spec file (only if "From YAML spec" was selected)
          const specFileItems = specFiles.map(file => ({ label: file }));
          const result = await showQuickPickWithBack(specFileItems, {
            title: 'Create Agent',
            placeholder: 'Select the agent spec YAML file',
            showBack: true
          });

          if (result === 'back') {
            step = 1;
            continue;
          }
          if (result === undefined) {
            return; // User cancelled
          }
          spec = path.join(specsDir, result.label);
          step = 3;
        } else if (step === 3) {
          // Step 3: Enter name
          const result = await showInputBoxWithBack({
            title: 'Create Agent',
            prompt: 'Enter the agent name',
            placeholder: 'Agent name',
            value: name,
            showBack: true,
            validateInput: value => {
              if (!value) {
                return 'Agent name is required.';
              }
              if (value.trim().length === 0) {
                return "Agent name can't be empty.";
              }
              return null;
            }
          });

          if (result === 'back') {
            step = selectedType?.isCustom ? 2 : 1;
            continue;
          }
          if (result === undefined) {
            return; // User cancelled
          }
          name = result;
          step = 4;
        } else if (step === 4) {
          // Fetch existing agent API names for duplicate validation
          let existingAgentNames = new Set<string>();
          try {
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(aiAuthoringBundlesDir));
            existingAgentNames = new Set(
              entries
                .filter(([, type]) => type === vscode.FileType.Directory)
                .map(([dirName]) => dirName.toLowerCase())
            );
          } catch {
            // Directory may not exist yet, which is fine — no duplicates possible
          }

          // Step 4: Enter API name
          const generatedApiName = generateApiName(name!);
          const result = await showInputBoxWithBack({
            title: 'Create Agent',
            prompt: 'Enter the agent API name',
            placeholder: 'API name',
            value: apiName ?? generatedApiName,
            showBack: true,
            validateInput: value => {
              if (value === '') {
                if (/^[A-Za-z][A-Za-z0-9_]*[A-Za-z0-9]+$/.test(generatedApiName)) {
                  if (existingAgentNames.has(generatedApiName.toLowerCase())) {
                    return 'An agent with this API name already exists.';
                  }
                  return null; // Empty accepted, uses default
                }
                return 'Invalid generated API name. Please enter a valid API name.';
              }
              if (value.length > 80) {
                return 'API name cannot be over 80 characters.';
              }
              if (!/^[A-Za-z][A-Za-z0-9_]*[A-Za-z0-9]+$/.test(value)) {
                return 'Invalid API name.';
              }
              if (existingAgentNames.has(value.toLowerCase())) {
                return 'An agent with this API name already exists.';
              }
              return null;
            }
          });

          if (result === 'back') {
            step = 3;
            continue;
          }
          if (result === undefined) {
            return; // User cancelled
          }
          apiName = result || generatedApiName;
          break; // Done with wizard
        }
      }

      if (!name || !apiName) {
        return;
      }

      // Show progress
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Generate Agent: ${apiName}`,
          cancellable: false
        },
        async progress => {
          progress.report({ message: 'Creating structure', increment: 50 });
          await new Promise(resolve => setTimeout(resolve, 300));

          progress.report({ message: 'Generating script file' });

          await ScriptAgent.createAuthoringBundle({
            project,
            agentSpec: {
              ...(spec ? (YAML.parse(readFileSync(spec, 'utf8')) as AgentJobSpec) : {}),
              ...{ name, developerName: apiName, role: `${name} description` }
            } as AgentJobSpec & { name: string; developerName: string },
            bundleApiName: apiName,
            outputDir: targetDir
          });

          progress.report({ message: 'Created successfully', increment: 100 });

          // Open the agent file
          // Agent.createAuthoringBundle creates the file at outputDir/aiAuthoringBundles/bundleApiName/bundleApiName.agent
          const agentFilePath = path.join(targetDir, 'aiAuthoringBundles', apiName, `${apiName}.agent`);
          const doc = await vscode.workspace.openTextDocument(agentFilePath);
          await vscode.window.showTextDocument(doc);

          // Refresh agent list and auto-select the newly created agent
          await vscode.commands.executeCommand('sf.agent.combined.view.refreshAgents', apiName);

          vscode.window.showInformationMessage(`Agent "${name}" was generated successfully.`);
        }
      );
    } catch (error) {
      const sfError = SfError.wrap(error);
      const errorMessage = `Failed to generate agent: ${sfError.message}`;
      logger.error(errorMessage, sfError);
      vscode.window.showErrorMessage(errorMessage);
      telemetryService?.sendException('createAiAuthoringBundle_failed', errorMessage);
    }
  });
};
