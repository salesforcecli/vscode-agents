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
import { AgentTestOutlineProvider } from './testOutlineProvider';
import {
  AgentTester,
  AgentforceStudioTester,
  createAgentTester,
  TestStatus,
  AgentTestResultsResponse,
  AgentforceStudioTestResultsResponse,
  AgentforceStudioTestStatusResponse,
  humanFriendlyName,
  metric
} from '@salesforce/agents';
import { Lifecycle } from '@salesforce/core';
import { Duration } from '@salesforce/kit';
import type { AgentTestGroupNode, TestNode } from '../types';
import { CoreExtensionService } from '../services/coreExtensionService';
import { AgentTestNode } from '../types';
import { formatJson } from '../utils/jsonFormatter';

type AgentTestResults = AgentTestResultsResponse & { id: string };
type AgentforceStudioTestResults = AgentforceStudioTestResultsResponse & { id: string };

type ParsedAgentforceStudioScorer =
  | { kind: 'latency'; passing: boolean; latencyMs: number; reasoning: string }
  | { kind: 'quality'; passing: boolean; score: number; reasoning: string }
  | { kind: 'assertion'; passing: boolean; expectedValue: string; actualValue: string }
  | { kind: 'unknown'; passing: boolean; raw: string };

function parseAgentforceStudioScorer(scorerResponse: string): ParsedAgentforceStudioScorer {
  try {
    const p = JSON.parse(scorerResponse) as {
      status?: string;
      score?: number;
      reasoning?: string;
      latencyMs?: number;
      actualValue?: string;
      expectedValue?: string;
    };
    // Quality/latency scorers carry a status field
    if (p.status !== undefined) {
      const passing = p.status.toUpperCase() === 'PASS';
      if (p.latencyMs !== undefined) {
        return { kind: 'latency', passing, latencyMs: p.latencyMs, reasoning: p.reasoning ?? '' };
      }
      return { kind: 'quality', passing, score: p.score ?? 0, reasoning: p.reasoning ?? '' };
    }
    // Assertion scorers compare actual vs expected
    if (p.actualValue !== undefined || p.expectedValue !== undefined) {
      const passing = p.actualValue !== undefined && p.actualValue === p.expectedValue;
      return { kind: 'assertion', passing, expectedValue: p.expectedValue ?? '', actualValue: p.actualValue ?? '' };
    }
    return { kind: 'unknown', passing: false, raw: scorerResponse };
  } catch {
    return { kind: 'unknown', passing: false, raw: scorerResponse };
  }
}

export class AgentTestRunner {
  private testGroupNameToResult = new Map<string, AgentTestResults>();
  private agentforceStudioTestGroupNameToResult = new Map<string, AgentforceStudioTestResults>();
  constructor(private testOutline: AgentTestOutlineProvider) {}

  /**
   * Displays error message when test results contain no test cases
   */
  private handleEmptyTestCases(channelService: ReturnType<typeof CoreExtensionService.getTestChannelService>): void {
    channelService.appendLine('We are unable to complete this test run because the test results do not contain any test cases.');
  }

  /**
   * Analyzes test result status to determine if it represents a failure
   */
  private isFailedStatus(status: string): boolean {
    return status.toUpperCase() === 'FAILED';
  }

  /**
   * Updates the outcome of a specific test case in the test outline
   */
  private updateTestCaseOutcome(testGroupName: string, testNumber: number, outcome: 'ERROR' | 'COMPLETED'): void {
    this.testOutline
      .getTestGroup(testGroupName)
      ?.getChildren()
      .find(child => child.name === `#${testNumber}`)
      ?.updateOutcome(outcome);
  }

  public displayTestDetails(test: TestNode) {
    const channelService = CoreExtensionService.getTestChannelService();
    channelService.showChannelOutput();
    channelService.clear();

    // Check Agentforce Studio results first, then fall back to standard results
    const agentforceStudioResult =
      this.agentforceStudioTestGroupNameToResult.get(test.name) ??
      this.agentforceStudioTestGroupNameToResult.get(test.parentName);
    if (agentforceStudioResult) {
      if (!test.parentName) {
        channelService.appendLine(`Job Id: ${agentforceStudioResult.id}`);
        this.printAgentforceStudioTestSummary(agentforceStudioResult);
        return;
      }
      const testInfo = structuredClone(agentforceStudioResult);
      if (test instanceof AgentTestNode) {
        testInfo.testCases = testInfo.testCases.filter(f => `#${f.testNumber}` === test.name);
      }
      channelService.appendLine(`Job Id: ${testInfo.id}`);
      channelService.appendLine(testInfo.status);
      channelService.appendLine('');
      this.displayAgentforceStudioTestCases(testInfo);
      return;
    }

    if (!test.parentName) {
      // this is the parent test group, so we only show the test summary, test id
      const result = this.testGroupNameToResult.get(test.name);
      if (result) {
        channelService.appendLine(`Job Id: ${result.id}`);
        this.printTestSummary(result!);
      } else {
        vscode.window.showErrorMessage('You must run the agent test first to see its results.');
      }

      return;
    }

    const resultFromMap = this.testGroupNameToResult.get(test.name) ?? this.testGroupNameToResult.get(test.parentName);
    if (!resultFromMap) {
      vscode.window.showErrorMessage('You need to run the test first to see its results.');
      return;
    }
    // set to a new var so we can remove test cases and not affect saved information
    const testInfo = structuredClone(resultFromMap);
    if (test instanceof AgentTestNode) {
      // filter to selected test case
      testInfo.testCases = testInfo.testCases.filter(f => `#${f.testNumber}` === test.name);
    }

    if (testInfo.testCases.length === 0) {
      this.handleEmptyTestCases(channelService);
      return;
    }

    testInfo.testCases.forEach(tc => {
      channelService.appendLine('════════════════════════════════════════════════════════════════════════');
      channelService.appendLine(`CASE #${tc.testNumber} - ${testInfo.subjectName}`);
      channelService.appendLine('════════════════════════════════════════════════════════════════════════');
      channelService.appendLine('');
      channelService.appendLine(`"${tc.inputs.utterance}"`);
      channelService.appendLine('');
      tc.testResults
        // this is the output for topics/action/output validation (actual v expected)
        // filter out other metrics from it
        .filter(f => !metric.includes(f.name as (typeof metric)[number]))
        .forEach(tr => {
          channelService.appendLine(
            `❯ ${humanFriendlyName(tr.name).toUpperCase()}: ${tr.result} ${tr.result === 'PASS' ? '✅' : '❌'}`
          );
          channelService.appendLine('────────────────────────────────────────────────────────────────────────');
          channelService.appendLine(`EXPECTED : ${tr.expectedValue.replaceAll('\n', '')}`);
          channelService.appendLine(`ACTUAL   : ${tr.actualValue.replaceAll('\n', '')}`);
          channelService.appendLine(`SCORE    : ${tr.score}`);
          channelService.appendLine('');
        });

      // Show generated data only if enabled in settings
      const showGeneratedData = vscode.workspace
        .getConfiguration('salesforce.agentforceDX')
        .get<boolean>('showGeneratedData');
      if (showGeneratedData && tc.generatedData?.actionsSequence?.length > 2) {
        channelService.appendLine('❯ ACTION: INVOCATION ℹ️');
        channelService.appendLine('────────────────────────────────────────────────────────────────────────');
        channelService.appendLine(formatJson(tc.generatedData.invokedActions));
        channelService.appendLine('');
      }

      const metricResults = tc.testResults
        // this is the output for metric information
        // filter out the standard evaluations (topics/action/output)
        .filter(f => metric.includes(f.name as (typeof metric)[number]));
      if (metricResults.length > 0) {
        channelService.appendLine(`❯ METRICS (Value/Threshold)`);
        channelService.appendLine('────────────────────────────────────────────────────────────────────────');
        metricResults.forEach(tr => {
          if (tr.name === 'output_latency_milliseconds') {
            channelService.appendLine(
              `⏱️ : ${humanFriendlyName(tr.name).toUpperCase()} (${tr.score}ms)  ${tr.metricExplainability ? `: ${tr.metricExplainability}` : ''}`
            );
          } else {
            channelService.appendLine(
              // 3 is the threshold for passing, hardcoded for now
              `${tr.result === 'PASS' ? '✅' : '❌'} : ${humanFriendlyName(tr.name).toUpperCase()} (${tr.score}/3) ${tr.metricExplainability ? `: ${tr.metricExplainability}` : ''}`
            );
          }
        });
      }

      channelService.appendLine('');
      channelService.appendLine('────────────────────────────────────────────────────────────────────────');
      channelService.appendLine(
        `TEST CASE SUMMARY: ${tc.testResults.length} tests run | ✅ ${tc.testResults.filter(tc => tc.result === 'PASS').length} passed | ❌ ${tc.testResults.filter(tc => tc.result === 'FAILURE').length} failed`
      );
    });
  }

  public async runAgentTest(test: AgentTestGroupNode) {
    const channelService = CoreExtensionService.getTestChannelService();
    const telemetryService = CoreExtensionService.getTelemetryService();
    const commandName = 'RunAgentTest';
    const hrstart = process.hrtime();
    telemetryService?.sendCommandEvent(commandName, hrstart, { commandName });
    try {
      const lifecycle = await Lifecycle.getInstance();
      channelService.clear();
      channelService.showChannelOutput();
      const connection = await CoreExtensionService.getDefaultConnection();
      const { runner, type } = await createAgentTester(connection, { explicitType: test.runnerType });
      channelService.appendLine(`Starting ${test.testDefinitionName} tests: ${new Date().toLocaleString()}`);

      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Running ${test.testDefinitionName}...`
        },
        async progress => {
          return new Promise((resolve, reject) => {
            lifecycle.on(
              'AGENT_TEST_POLLING_EVENT',
              async (data: {
                status: TestStatus | AgentforceStudioTestStatusResponse['status'];
                completedTestCases: number;
                totalTestCases: number;
                failingTestCases: number;
                passingTestCases: number;
              }) => {
                const statusUpper = data.status.toUpperCase();
                if (['NEW', 'IN_PROGRESS', 'CREATED'].includes(statusUpper)) {
                  // every time IN_PROGRESS is returned, 10 is added, is possible to 100% progress bar and tests not be done
                  progress.report({ increment: 10, message: `Status: In Progress` });
                } else if (['ERROR', 'TERMINATED', 'FAILED'].includes(statusUpper)) {
                  progress.report({ increment: 100, message: `Status: ${data.status}` });
                  setTimeout(() => reject(), 1500);
                } else if (['COMPLETED', 'SUCCESS'].includes(statusUpper)) {
                  progress.report({ increment: 100, message: `Status: ${data.status}` });
                  setTimeout(() => resolve({}), 1500);
                } else {
                  channelService.appendLine(`Warning: Unexpected test status: ${data.status}`);
                }
              }
            );
          });
        }
      );

      if (type === 'agentforce-studio') {
        await this.runAgentforceStudioTest(test, runner as AgentforceStudioTester, channelService);
      } else {
        await this.runTestingCenterTest(test, runner as AgentTester, channelService);
      }
    } catch (e) {
      const error = e as Error;
      void Lifecycle.getInstance().emit('AGENT_TEST_POLLING_EVENT', { status: 'ERROR' });
      this.testOutline.getTestGroup(test.name)?.updateOutcome('ERROR', true);
      channelService.appendLine(`Error running test: ${error.message}`);
      telemetryService?.sendException(error.name, error.message);
    }
  }

  private async runTestingCenterTest(
    test: AgentTestGroupNode,
    tester: AgentTester,
    channelService: ReturnType<typeof CoreExtensionService.getTestChannelService>
  ): Promise<void> {
    const response = await tester.start(test.testDefinitionName);
    channelService.appendLine(`Job Id: ${response.runId}`);
    this.testOutline.getTestGroup(test.name)?.updateOutcome('IN_PROGRESS', true);

    const result = {
      ...(await tester.poll(response.runId, { timeout: Duration.minutes(100) })),
      id: response.runId
    };

    this.testGroupNameToResult.set(test.name, result);

    const isFailed = this.isFailedStatus(result.status);
    let hasFailure = isFailed;

    if (result.testCases.length === 0) {
      // If there are no test cases, mark test group and children as ERROR
      this.testOutline.getTestGroup(test.name)?.updateOutcome('ERROR', true);
    } else {
      result.testCases.forEach(tc => {
        const tcFailed = tc.testResults.some(tr => tr.result === 'FAILURE');
        if (tcFailed) hasFailure = true;
        this.updateTestCaseOutcome(test.name, tc.testNumber, tcFailed || isFailed ? 'ERROR' : 'COMPLETED');
      });
      this.testOutline.getTestGroup(test.name)?.updateOutcome(hasFailure ? 'ERROR' : 'COMPLETED');
    }
    this.printTestSummary(result);
  }

  private async runAgentforceStudioTest(
    test: AgentTestGroupNode,
    tester: AgentforceStudioTester,
    channelService: ReturnType<typeof CoreExtensionService.getTestChannelService>
  ): Promise<void> {
    const response = await tester.start(test.testDefinitionName);
    channelService.appendLine(`Job Id: ${response.runId}`);
    this.testOutline.getTestGroup(test.name)?.updateOutcome('IN_PROGRESS', true);

    const result: AgentforceStudioTestResults = {
      ...(await tester.poll(response.runId, { timeout: Duration.minutes(100) })),
      id: response.runId
    };

    this.agentforceStudioTestGroupNameToResult.set(test.name, result);

    const isFailed = this.isFailedStatus(result.status);
    let hasFailure = isFailed;

    if (result.testCases.length === 0) {
      // If there are no test cases, mark test group and children as ERROR
      this.testOutline.getTestGroup(test.name)?.updateOutcome('ERROR', true);
    } else {
      result.testCases.forEach(tc => {
        // A test case with no scorer results has not been evaluated and counts as a failure
        const tcFailed =
          tc.testScorerResults.length === 0 ||
          tc.testScorerResults.some(s => !parseAgentforceStudioScorer(s.scorerResponse).passing);
        if (tcFailed) hasFailure = true;
        this.updateTestCaseOutcome(test.name, tc.testNumber, tcFailed || isFailed ? 'ERROR' : 'COMPLETED');
      });
      this.testOutline.getTestGroup(test.name)?.updateOutcome(hasFailure ? 'ERROR' : 'COMPLETED');
    }
    this.printAgentforceStudioTestSummary(result);
  }

  private displayAgentforceStudioTestCases(testInfo: AgentforceStudioTestResults): void {
    const channelService = CoreExtensionService.getTestChannelService();

    if (testInfo.testCases.length === 0) {
      this.handleEmptyTestCases(channelService);
      return;
    }

    testInfo.testCases.forEach(tc => {
      channelService.appendLine('════════════════════════════════════════════════════════════════════════');
      channelService.appendLine(`CASE #${tc.testNumber}`);
      channelService.appendLine('════════════════════════════════════════════════════════════════════════');
      channelService.appendLine('');
      let passing = 0;
      tc.testScorerResults.forEach(scorer => {
        const parsed = parseAgentforceStudioScorer(scorer.scorerResponse);
        if (parsed.passing) passing++;
        const icon = parsed.passing ? '✅' : '❌';
        const verdict = parsed.passing ? 'PASS' : 'FAILURE';
        channelService.appendLine(`❯ ${scorer.scorerName.toUpperCase()}: ${verdict} ${icon}`);
        channelService.appendLine('────────────────────────────────────────────────────────────────────────');
        if (parsed.kind === 'assertion') {
          channelService.appendLine(`EXPECTED : ${parsed.expectedValue.replaceAll('\n', '')}`);
          channelService.appendLine(`ACTUAL   : ${parsed.actualValue.replaceAll('\n', '')}`);
        } else if (parsed.kind === 'latency') {
          channelService.appendLine(`LATENCY  : ${parsed.latencyMs}ms`);
          if (parsed.reasoning) {
            channelService.appendLine(`REASONING: ${parsed.reasoning}`);
          }
        } else if (parsed.kind === 'quality') {
          channelService.appendLine(`SCORE    : ${parsed.score}`);
          if (parsed.reasoning) {
            channelService.appendLine(`REASONING: ${parsed.reasoning}`);
          }
        } else {
          channelService.appendLine(`RESPONSE : ${parsed.raw}`);
        }
        channelService.appendLine('');
      });

      const failing = tc.testScorerResults.length - passing;
      channelService.appendLine('────────────────────────────────────────────────────────────────────────');
      channelService.appendLine(
        `TEST CASE SUMMARY: ${tc.testScorerResults.length} tests run | ✅ ${passing} passed | ❌ ${failing} failed`
      );
    });
  }

  private printTestSummary(result: AgentTestResults) {
    const channelService = CoreExtensionService.getTestChannelService();
    channelService.appendLine(result.status);
    channelService.appendLine('');

    if (result.testCases.length === 0) {
      this.handleEmptyTestCases(channelService);
      return;
    }

    channelService.appendLine('Test Results');
    const total = result.testCases.length;
    const passing = result.testCases.filter(tc => tc.testResults.every(tr => tr.result === 'PASS')).length;
    channelService.appendLine(`Passing: ${passing}/${total}`);
    channelService.appendLine(`Failing: ${total - passing}/${total}`);
    channelService.appendLine('');
    channelService.appendLine(`Select a test case in the Test View panel for more information`);
  }

  private printAgentforceStudioTestSummary(result: AgentforceStudioTestResults): void {
    const channelService = CoreExtensionService.getTestChannelService();
    channelService.appendLine(result.status);
    channelService.appendLine('');

    if (result.testCases.length === 0) {
      this.handleEmptyTestCases(channelService);
      return;
    }

    const tcPassing = (tc: (typeof result.testCases)[number]): boolean =>
      tc.testScorerResults.length > 0 &&
      tc.testScorerResults.every(s => parseAgentforceStudioScorer(s.scorerResponse).passing);
    channelService.appendLine('Test Results');
    const total = result.testCases.length;
    const passing = result.testCases.filter(tcPassing).length;
    channelService.appendLine(`Passing: ${passing}/${total}`);
    channelService.appendLine(`Failing: ${total - passing}/${total}`);
    channelService.appendLine('');
    channelService.appendLine(`Select a test case in the Test View panel for more information`);
  }
}
