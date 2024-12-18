import * as vscode from 'vscode';
import { Commands } from '../enums/commands';
import { SfProject } from '@salesforce/core';
import * as path from 'path';
import { execSync } from 'node:child_process';

export const registerOpenAgentInOrgCommand = () => {
  return vscode.commands.registerCommand(Commands.openAgentInOrg, async () => {
    // we need to prompt the user which agent to open
    // TODO: maybe an Agent.listLocal() or something similar in the library
    const project = SfProject.getInstance();
    const defaultPath = project.getDefaultPackage().fullPath;
    const agents = (
      await vscode.workspace.fs.readDirectory(vscode.Uri.file(path.join(defaultPath, 'main', 'default', 'bots')))
    ).map(f => f[0]);

    const agentName = await vscode.window.showQuickPick(agents, { title: 'Choose which Agent to open' });

    if (!agentName) {
      throw new Error('Agent must be selected');
    }

    const res = execSync(`sf org open agent --name "${agentName}"`);

    if (!res) {
      throw new Error('abc');
    }
  });
};
