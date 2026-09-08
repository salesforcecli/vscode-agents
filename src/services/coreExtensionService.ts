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
import { satisfies, valid } from 'semver';
import { Event, ExtensionContext, extensions, window } from 'vscode';
import { ChannelService } from '../types';
import { TelemetryService } from '../types/TelemetryService';
import { CoreExtensionApi } from '../types/CoreExtension';
import { WorkspaceContext } from '../types/WorkspaceContext';
import { Connection, ConfigAggregator, Org } from '@salesforce/core';
import { ColoredChannelService } from '../utils/coloredChannelService';

export interface OrgChangeEvent {
  username?: string;
  alias?: string;
}

const CORE_EXTENSION_ID = 'salesforce.salesforcedx-vscode-core';
export const NOT_INITIALIZED_ERROR = 'CoreExtensionService not initialized';
export const CHANNEL_SERVICE_NOT_FOUND = 'ChannelService not found';
export const TELEMETRY_SERVICE_NOT_FOUND = 'TelemetryService not found';
export const CORE_EXTENSION_NOT_FOUND = 'Core extension not found';
export const WORKSPACE_CONTEXT_NOT_FOUND = 'Workspace Context not found';

export class CoreExtensionService {
  private static initialized = false;
  private static channelService: ChannelService;
  private static testChannelService: ChannelService;
  private static telemetryService: TelemetryService;
  private static workspaceContext: WorkspaceContext;

  static get isInitialized(): boolean {
    return CoreExtensionService.initialized;
  }

  static async loadDependencies(context: ExtensionContext): Promise<void> {
    if (!CoreExtensionService.initialized) {
      try {
        const coreExtensionApi = CoreExtensionService.validateCoreExtension();

        CoreExtensionService.initializeChannelService(coreExtensionApi?.services.ChannelService);
        CoreExtensionService.initializeTelemetryService(coreExtensionApi?.services.TelemetryService, context);
        CoreExtensionService.initializeWorkspaceContext(coreExtensionApi?.services.WorkspaceContext);

        CoreExtensionService.initialized = true;
      } catch (error) {
        console.warn('[CoreExtensionService] Failed to initialize core extension dependencies:', error);
        // Initialize fallback services so extension can still function
        CoreExtensionService.channelService = new ColoredChannelService('Agentforce DX');
        CoreExtensionService.testChannelService = new ColoredChannelService('Agentforce DX Tests');
        // Leave telemetryService and workspaceContext undefined - commands will handle gracefully
      }
    }
  }

  private static initializeWorkspaceContext(workspaceContext: WorkspaceContext | undefined) {
    if (!workspaceContext) {
      throw new Error(WORKSPACE_CONTEXT_NOT_FOUND);
    }
    CoreExtensionService.workspaceContext = workspaceContext.getInstance(false);
  }

  public static getCoreExtensionVersion(): string {
    const coreExtension = extensions.getExtension(CORE_EXTENSION_ID);
    if (!coreExtension) {
      throw new Error(CORE_EXTENSION_NOT_FOUND);
    }
    return coreExtension.packageJSON.version;
  }

  private static validateCoreExtension(): CoreExtensionApi {
    const coreExtension = extensions.getExtension(CORE_EXTENSION_ID);
    if (!coreExtension) {
      throw new Error(CORE_EXTENSION_NOT_FOUND);
    }
    const coreExtensionVersion = CoreExtensionService.getCoreExtensionVersion();
    if (!CoreExtensionService.isAboveMinimumRequiredVersion('60.13.0', coreExtensionVersion)) {
      throw new Error(
        "It looks you're running an older version of the Salesforce CLI Integration VS Code Extension. Update the Salesforce Extension Pack and try again."
      );
    }
    return coreExtension.exports;
  }

  private static initializeChannelService(channelService: ChannelService | undefined): void {
    if (!channelService) {
      throw new Error(CHANNEL_SERVICE_NOT_FOUND);
    }
    // Initialize extension channel for general extension logging with syntax highlighting
    CoreExtensionService.channelService = new ColoredChannelService('Agentforce DX');
    // Initialize test channel for agent test output (keep original for test output formatting)
    CoreExtensionService.testChannelService = channelService.getInstance('Agentforce DX Tests');
  }

  private static initializeTelemetryService(
    telemetryService: TelemetryService | undefined,
    context: ExtensionContext
  ): void {
    if (!telemetryService) {
      throw new Error(TELEMETRY_SERVICE_NOT_FOUND);
    }
    const { aiKey, version } = context.extension.packageJSON;
    // Use "AgentforceDX" as the extension name for telemetry
    const extensionName = 'AgentforceDX';
    CoreExtensionService.telemetryService = telemetryService.getInstance(extensionName);
    void CoreExtensionService.telemetryService.initializeService(context, extensionName, aiKey, version);
  }

  public static isAboveMinimumRequiredVersion(minRequiredVersion: string, actualVersion: string): boolean {
    // Check to see if version is in the expected MAJOR.MINOR.PATCH format
    if (!valid(actualVersion)) {
      void window.showWarningMessage(
        `Invalid version format found for the Core Extension ${actualVersion} < ${minRequiredVersion}`
      );
    }
    return satisfies(actualVersion, '>=' + minRequiredVersion);
  }

  static getChannelService(): ChannelService {
    // Return channel service even if not fully initialized - we have a fallback
    if (CoreExtensionService.channelService) {
      return CoreExtensionService.channelService;
    }
    throw new Error(NOT_INITIALIZED_ERROR);
  }

  static getTestChannelService(): ChannelService {
    // Return test channel service even if not fully initialized - we have a fallback
    if (CoreExtensionService.testChannelService) {
      return CoreExtensionService.testChannelService;
    }
    throw new Error(NOT_INITIALIZED_ERROR);
  }

  static async getDefaultConnection(): Promise<Connection> {
    if (CoreExtensionService.initialized) {
      return await CoreExtensionService.workspaceContext.getConnection();
    }
    // Fallback: create connection directly when core extension is not available
    try {
      const configAggregator = await ConfigAggregator.create();
      const targetOrg = configAggregator.getPropertyValue<string>('target-org');
      if (!targetOrg) {
        throw new Error('No default org configured. Set a default org with: sf config set target-org=<username>');
      }
      const org = await Org.create({ aliasOrUsername: targetOrg });
      return org.getConnection();
    } catch (error) {
      throw new Error(`${NOT_INITIALIZED_ERROR}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  static getTelemetryService(): TelemetryService | undefined {
    // Return telemetry service if available, undefined otherwise
    // Commands should check for undefined and skip telemetry calls
    return CoreExtensionService.telemetryService;
  }

  static getOnOrgChangeEvent(): Event<OrgChangeEvent> {
    if (CoreExtensionService.initialized) {
      return CoreExtensionService.workspaceContext.onOrgChange;
    }
    throw new Error(NOT_INITIALIZED_ERROR);
  }
}
