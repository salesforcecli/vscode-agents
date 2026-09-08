import * as vscode from 'vscode';
import { Commands } from '../enums/commands';
import { SfProject, Lifecycle } from '@salesforce/core';
import { Agent } from '@salesforce/agents';
import { CoreExtensionService } from '../services/coreExtensionService';
import { SfError } from '@salesforce/core';
import * as path from 'path';
import { EOL } from 'os';
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

export const registerPublishAgentCommand = () => {
  return vscode.commands.registerCommand(Commands.publishAgent, async (uri?: vscode.Uri) => {
    const telemetryService = CoreExtensionService.getTelemetryService();
    const logger = new Logger(CoreExtensionService.getChannelService());
    const commandName = Commands.publishAgent;
    const hrstart = process.hrtime();
    telemetryService?.sendCommandEvent(commandName, hrstart, { commandName });

    // Get the file path from the context menu
    const filePath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;

    if (!filePath) {
      vscode.window.showErrorMessage('No .agent file selected.');
      return;
    }

    // Validate that this is a .agent file
    if (!filePath.endsWith('.agent')) {
      vscode.window.showErrorMessage('You can use this command on only .agent files.');
      return;
    }

    try {
      const project = SfProject.getInstance();
      const fileName = path.basename(filePath, '.agent');

      // Clear previous output
      logger.clear();

      // Log SF_SKIP_RETRIEVE setting value
      logger.debug(`SF_SKIP_RETRIEVE = ${process.env.SF_SKIP_RETRIEVE ?? 'false'}`);
      logger.debug(`Publishing agent ${fileName}...`);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Publish: ${fileName}`,
          cancellable: false
        },
        async progress => {
          try {
            // Get connection to the org
            const connection = await CoreExtensionService.getDefaultConnection();

            // Initialize agent instance using Agent.init()
            progress.report({ message: 'Initializing', increment: 0 });
            // Extract just the name (basename) from the directory containing the .agent file
            const aabDirectory = path.resolve(path.dirname(filePath));
            const aabName = path.basename(aabDirectory);
            const agent = await Agent.init({
              connection,
              project,
              aabName
            });

            // Step 1: Validate the agent first
            progress.report({ message: 'Validating', increment: 20 });
            const validateResponse = await agent.compile();

            // Check if validation failed
            if (validateResponse.status === 'failure' && validateResponse.errors) {
              const errorMessages = validateResponse.errors
                .map(
                  (error: CompilationError) =>
                    `[${error.errorType}] Line ${error.lineStart}:${error.colStart} - ${error.description}`
                )
                .join(EOL);

              logger.error(`Agent validation failed with ${validateResponse.errors.length} error(s)`);
              errorMessages.split(EOL).forEach((errorLine, index) => {
                if (errorLine.trim()) {
                  logger.errorDetail(`${index + 1}. ${errorLine}`);
                }
              });

              progress.report({ message: `Validation failed with ${validateResponse.errors.length} error(s)` });

              vscode.window.showErrorMessage(
                `Agent validation failed with ${validateResponse.errors.length} error(s). See the Problems panel for details.`
              );
              return;
            }

            // Step 2: Publish the agent
            progress.report({ message: 'Publishing', increment: 50 });

            const lifecycle = Lifecycle.getInstance();

            // Register event listeners
            lifecycle.on('scopedPreRetrieve', async () => {
              progress.report({ message: 'Retrieving metadata', increment: 70 });
              logger.debug('Retrieving metadata from org...');
            });

            lifecycle.on('scopedPostRetrieve', async () => {
              progress.report({ message: 'Metadata retrieved', increment: 90 });
              logger.debug('Metadata retrieved successfully.');
            });

            try {
              await agent.publish(
                  vscode.workspace
                  .getConfiguration('salesforce.agentforceDX')
                  .get<boolean>('skipRetrieve', false));
            } finally {
              // Clean up event listeners
              lifecycle.removeAllListeners('scopedPreRetrieve');
              lifecycle.removeAllListeners('scopedPostRetrieve');
            }

            progress.report({ message: 'Published successfully', increment: 100 });
            vscode.window.showInformationMessage(`Agent "${fileName}" was published successfully.`);
          } catch (publishError) {
            const sfError = SfError.wrap(publishError);
            logger.error('Agent publish failed', sfError);

            progress.report({ message: 'Publish failed' });

            vscode.window.showErrorMessage(`Failed to publish agent: ${sfError.message}`);
            telemetryService?.sendException('agent_publish_failed', sfError.message);
          }
        }
      );
    } catch (error) {
      const sfError = SfError.wrap(error);
      const errorMessage = `Failed to publish agent: ${sfError.message}`;
      logger.error(errorMessage, sfError);
      vscode.window.showErrorMessage(errorMessage);
      telemetryService?.sendException('agent_publish_failed', errorMessage);
    }
  });
};
