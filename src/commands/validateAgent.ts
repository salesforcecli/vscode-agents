import * as vscode from 'vscode';
import { Commands } from '../enums/commands';
import { Agent, ScriptAgent } from '@salesforce/agents';
import { CoreExtensionService } from '../services/coreExtensionService';
import { SfError, SfProject } from '@salesforce/core';
import * as path from 'path';
import { Logger } from '../utils/logger';

// Type declarations for new library API
interface CompilationError {
  errorType: string;
  lineStart: number;
  colStart: number;
  lineEnd: number;
  colEnd: number;
  description: string;
}

// Diagnostic collection for agent validation errors
let diagnosticCollection: vscode.DiagnosticCollection;

export function initializeDiagnosticCollection(context: vscode.ExtensionContext) {
  diagnosticCollection = vscode.languages.createDiagnosticCollection('agentValidation');
  context.subscriptions.push(diagnosticCollection);
}

export const registerValidateAgentCommand = () => {
  return vscode.commands.registerCommand(Commands.validateAgent, async (uri?: vscode.Uri) => {
    const telemetryService = CoreExtensionService.getTelemetryService();
    const logger = new Logger(CoreExtensionService.getChannelService());
    const commandName = Commands.validateAgent;
    const hrstart = process.hrtime();
    telemetryService?.sendCommandEvent(commandName, hrstart, { commandName });

    // Get the file path from the context menu
    const filePath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;

    if (!filePath) {
      vscode.window.showErrorMessage('No .agent file selected.');
      telemetryService?.sendException('validateAgent_failed', 'No .agent file selected.');
      return;
    }

    // Strip "local:" prefix if present (agents library may return paths with this prefix)
    const normalizedFilePath = filePath.startsWith('local:') ? filePath.substring(6) : filePath;

    const fileUri = vscode.Uri.file(normalizedFilePath);
    await vscode.workspace.fs.readFile(fileUri);

    // Clear previous output
    logger.clear();

    // Show progress notification with spinner
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Validate Agent',
        cancellable: false
      },
      async progress => {
        progress.report({ message: 'Validating' });
        let agent: ScriptAgent | undefined;
        try {
          const connection = await CoreExtensionService.getDefaultConnection();
          const project = SfProject.getInstance();

          // Initialize agent instance using Agent.init()
          // Extract just the name (basename) from the directory containing the .agent file
          const aabDirectory = path.resolve(path.dirname(normalizedFilePath));
          const aabName = path.basename(aabDirectory);
          agent = await Agent.init({
            connection,
            project,
            aabName
          });

          // Validate the agent
          const response = await agent.compile();

          // Type guard to check if response has errors (compilation failure)
          if (response.status === 'failure' && response.errors) {
            // Parse and display compilation errors in Problems panel
            const diagnostics: vscode.Diagnostic[] = response.errors.map((error: CompilationError) => {
              const range = new vscode.Range(
                new vscode.Position(Math.max(0, error.lineStart - 1), Math.max(0, error.colStart - 1)),
                new vscode.Position(Math.max(0, error.lineEnd - 1), Math.max(0, error.colEnd - 1))
              );

              const diagnostic = new vscode.Diagnostic(range, error.description, vscode.DiagnosticSeverity.Error);
              diagnostic.source = 'Agent Validation';
              diagnostic.code = error.errorType;

              return diagnostic;
            });

            diagnosticCollection.set(fileUri, diagnostics);

            // Also show in output channel
            logger.error(`Agent validation failed with ${response.errors.length} error(s)`);
            response.errors.forEach((error: CompilationError, index: number) => {
              logger.errorDetail(`${index + 1}. [${error.errorType}] Line ${error.lineStart}:${error.colStart}`);
              logger.errorDetail(`   ${error.description}`);
            });

            // Update progress message to show failure
            progress.report({ message: `Validation failed with ${response.errors.length} error(s)` });

            // Wait a moment so user can see the failure message
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Automatically focus on the Problems panel to show errors
            await vscode.commands.executeCommand('workbench.action.problems.focus');
          } else {
            // Compilation successful
            diagnosticCollection.clear();

            // Update progress message to show success
            progress.report({ message: 'Validation successful', increment: 100 });

            // Keep the success message visible for a moment
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        } catch (compileError) {
          const sfError = SfError.wrap(compileError);
          // Clear diagnostics for unexpected errors
          diagnosticCollection.clear();
          // Show error details in output
          logger.error('Agent validation failed', sfError);

          // Update progress to show error
          progress.report({ message: 'Validation failed' });
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Show error message for unexpected errors
          vscode.window.showErrorMessage(`Agent validation failed: ${sfError.message}`);
          telemetryService?.sendException('validateAgent_failed', sfError.message);
        }
      }
    );
  });
};
