import * as vscode from 'vscode';
import { Commands } from '../enums/commands';
import { CoreExtensionService } from '../services/coreExtensionService';
import { getAgentNameFromPath, selectAgentFromProject, getConnectionAndProject, handleCommandError } from './agentUtils';
import { Logger } from '../utils/logger';

export const registerOpenAgentInOrgCommand = () => {
  return vscode.commands.registerCommand(Commands.openAgentInOrg, async (uri?: vscode.Uri) => {
    const telemetryService = CoreExtensionService.getTelemetryService();
    const logger = new Logger(CoreExtensionService.getChannelService());
    const commandName = Commands.openAgentInOrg;
    const hrstart = process.hrtime();
    telemetryService?.sendCommandEvent(commandName, hrstart, { commandName });

    let agentName: string | undefined;

    // If called from context menu with a file/directory, use that to determine the agent
    if (uri?.fsPath) {
      try {
        agentName = await getAgentNameFromPath(uri.fsPath);
      } catch (error) {
        console.warn('Failed to get agent name from path, falling back to picker:', error);
      }
    }

    // If no agent name from context, prompt user to select
    if (!agentName) {
      agentName = await selectAgentFromProject(logger, telemetryService);
      if (!agentName) {
        return;
      }
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Open Agent in Org',
        cancellable: true
      },
      async progress => {
        progress.report({ message: `Opening ${agentName}` });

        try {
          // Get org connection
          const { conn, org } = await getConnectionAndProject();

          // Query BotDefinition to get the Bot ID (same as CLI does)
          // Escape single quotes in agent name to prevent SQL injection
          const escapedAgentName = agentName.replace(/'/g, "''");
          const query = `SELECT Id FROM BotDefinition WHERE DeveloperName='${escapedAgentName}'`;
          const result = await conn.singleRecordQuery<{ Id: string }>(query, { tooling: false });

          if (!result?.Id) {
            vscode.window.showErrorMessage(`Agent "${agentName}" not found in org.`);
            logger.error(`Agent "${agentName}" not found in org.`);
            logger.debug(
              'Suggestion: Ensure the agent is deployed to your org with the "project deploy start" CLI command.'
            );
            telemetryService?.sendException('agent_not_found', `Agent "${agentName}" not found in org`);
            return;
          }

          const botId = result.Id;

          // Construct the Agent Builder redirect URL (same as CLI)
          const redirectUri = `AiCopilot/copilotStudio.app#/copilot/builder?copilotId=${botId}`;

          // Generate frontdoor URL with authentication
          const frontdoorUrl = await org.getFrontDoorUrl(redirectUri);

          // Open in browser using VS Code
          // Cast to Uri to prevent VS Code from parsing/encoding the URL
          // This preserves the already-encoded URL exactly as-is
          await vscode.env.openExternal(frontdoorUrl as unknown as vscode.Uri); // doesn't change string

          vscode.window.showInformationMessage('Agent opened successfully in the default org.');
        } catch (error) {
          handleCommandError(error, 'Unable to open agent', 'open_agent_failed', logger, telemetryService);
        }
      }
    );
  });
};
