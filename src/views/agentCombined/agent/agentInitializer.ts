import * as path from 'path';
import { promises as fs } from 'fs';
import { Agent, ScriptAgent, ProductionAgent, findAuthoringBundle } from '@salesforce/agents';
import { Lifecycle, SfProject, Connection } from '@salesforce/core';
import type { AgentViewState } from '../state/agentViewState';

/**
 * Handles agent initialization logic
 */
export class AgentInitializer {
  constructor(private readonly state: AgentViewState) {}

  /**
   * Initializes a script agent
   */
  async initializeScriptAgent(
    filePath: string,
    conn: Connection,
    project: SfProject,
    _isLiveMode: boolean,
    isActive: () => boolean,
    onCompiling?: (data: { message?: string; error?: string }) => void,
    onSimulationStarting?: (data: { message?: string }) => void
  ): Promise<ScriptAgent> {
    // Set up lifecycle event listeners for compilation progress
    const lifecycle = Lifecycle.getInstance();
    lifecycle.removeAllListeners?.('agents:compiling');
    lifecycle.removeAllListeners?.('agents:simulation-starting');

    // Listen for compilation events
    if (onCompiling) {
      lifecycle.on('agents:compiling', async (data: { message?: string; error?: string }) => {
        if (!isActive()) {
          return;
        }
        onCompiling(data);
      });
    }

    // Listen for simulation starting event
    if (onSimulationStarting) {
      lifecycle.on('agents:simulation-starting', async (data: { message?: string }) => {
        if (!isActive()) {
          return;
        }
        onSimulationStarting(data);
      });
    }

    // Create agent instance
    // filePath might be either:
    // 1. A file path to a .agent file
    // 2. A directory path - in which case we need to find the .agent file
    // 3. A path with a "local:" prefix (from Agent.listPreviewable) - strip the prefix
    // 4. Just the name of the authoring bundle (aabName)
    let aabDirectory: string;

    // Strip "local:" prefix if present (agents library may return paths with this prefix)
    const normalizedPath = filePath.startsWith('local:') ? filePath.substring(6) : filePath;

    try {
      // Check if filePath is a directory
      const stats = await fs.stat(normalizedPath);
      if (stats.isDirectory()) {
        // It's already a directory, verify it contains a .agent file
        const files = await fs.readdir(normalizedPath);
        const agentFile = files.find(f => f.endsWith('.agent'));
        if (!agentFile) {
          throw new Error(`Directory ${normalizedPath} does not contain a .agent file`);
        }
        aabDirectory = path.resolve(normalizedPath);
      } else if (normalizedPath.endsWith('.agent')) {
        // It's a .agent file, the bundle directory is the parent directory
        aabDirectory = path.resolve(path.dirname(normalizedPath));
        // Verify the directory contains the .agent file
        const files = await fs.readdir(aabDirectory);
        const agentFile = files.find(f => f.endsWith('.agent'));
        if (!agentFile) {
          throw new Error(`Directory ${aabDirectory} does not contain a .agent file`);
        }
      } else {
        // It's a file path, use findAuthoringBundle to get the directory
        const authoringBundle = findAuthoringBundle(project.getPath(), normalizedPath);
        if (!authoringBundle) {
          throw new Error(`Could not find authoring bundle for file: ${normalizedPath}`);
        }
        aabDirectory = path.resolve(authoringBundle);
      }
    } catch {
      // If stat fails, it might be just a name (aabName), not a path
      // Check if it's a .agent file path
      if (normalizedPath.endsWith('.agent')) {
        aabDirectory = path.resolve(path.dirname(normalizedPath));
      } else {
        // Try findAuthoringBundle as fallback
        const authoringBundle = findAuthoringBundle(project.getPath(), normalizedPath);
        if (!authoringBundle) {
          // If findAuthoringBundle fails, assume it's just a name (aabName)
          // Extract just the name from the path if it contains path separators
          const aabName = normalizedPath.includes(path.sep) ? path.basename(normalizedPath) : normalizedPath;
          const agent = await Agent.init({
            connection: conn,
            aabName,
            project: project
          });
          this.state.agentInstance = agent;
          return agent as ScriptAgent;
        }
        aabDirectory = path.resolve(authoringBundle);
      }
    }

    // Extract just the name (basename) from the directory path
    const aabName = path.basename(aabDirectory);

    const agent = await Agent.init({
      connection: conn,
      aabName,
      project: project
    });
    agent.preview.setMockMode(_isLiveMode ? 'Live Test' : 'Mock');

    this.state.agentInstance = agent;
    return agent as ScriptAgent;
  }

  /**
   * Initializes a published agent
   */
  async initializePublishedAgent(agentId: string, conn: Connection, project: SfProject): Promise<ProductionAgent> {
    const agent = await Agent.init({
      connection: conn,
      project: project,
      apiNameOrId: agentId
    });

    this.state.agentInstance = agent;
    return agent as ProductionAgent;
  }
}
