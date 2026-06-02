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
import { AgentTestRunner } from '../../src/views/testRunner';
import { AgentTestOutlineProvider } from '../../src/views/testOutlineProvider';
import { CoreExtensionService } from '../../src/services/coreExtensionService';
import { AgentTestGroupNode, AgentTestNode } from '../../src/types';

describe('AgentTestRunner', () => {
  let testRunner: AgentTestRunner;
  let testOutline: AgentTestOutlineProvider;
  let channelService: any;

  beforeEach(() => {
    jest.spyOn(vscode.extensions, 'getExtension').mockReturnValue({
      extensionUri: { fsPath: '/fake/path/to/extension' }
    } as any);

    testOutline = new AgentTestOutlineProvider();
    testRunner = new AgentTestRunner(testOutline);

    channelService = {
      appendLine: jest.fn(),
      clear: jest.fn(),
      showChannelOutput: jest.fn()
    };

    jest.spyOn(CoreExtensionService, 'getTestChannelService').mockReturnValue(channelService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('displayTestDetails with empty testCases', () => {
    it('should display error message when Agentforce Studio testCases array is empty', () => {
      const testGroup = new AgentTestGroupNode('TestGroup');
      const emptyResult = {
        id: 'test-run-id',
        status: 'COMPLETED',
        testCases: []
      };

      // @ts-ignore - accessing private property for testing
      testRunner.agentforceStudioTestGroupNameToResult.set('TestGroup', emptyResult);

      testRunner.displayTestDetails(testGroup);

      expect(channelService.appendLine).toHaveBeenCalledWith('Job Id: test-run-id');
      expect(channelService.appendLine).toHaveBeenCalledWith('COMPLETED');
      expect(channelService.appendLine).toHaveBeenCalledWith(
        'We are unable to complete this test run because the test results do not contain any test cases.'
      );
    });

    it('should display error message when regular testCases array is empty', () => {
      const testGroup = new AgentTestGroupNode('TestGroup');
      const emptyResult = {
        id: 'test-run-id',
        status: 'COMPLETED',
        testCases: [],
        subjectName: 'Test Subject'
      };

      // @ts-ignore - accessing private property for testing
      testRunner.testGroupNameToResult.set('TestGroup', emptyResult);

      testRunner.displayTestDetails(testGroup);

      expect(channelService.appendLine).toHaveBeenCalledWith('Job Id: test-run-id');
      expect(channelService.appendLine).toHaveBeenCalledWith(
        'We are unable to complete this test run because the test results do not contain any test cases.'
      );
    });

    it('should display error message when filtered testCases results in empty array', () => {
      const testGroup = new AgentTestGroupNode('TestGroup');
      const testNode = new AgentTestNode('#2');
      testNode.parentName = 'TestGroup';

      const result = {
        id: 'test-run-id',
        status: 'COMPLETED',
        testCases: [
          {
            testNumber: '1',
            inputs: { utterance: 'test utterance' },
            testResults: []
          }
        ],
        subjectName: 'Test Subject'
      };

      // @ts-ignore - accessing private property for testing
      testRunner.testGroupNameToResult.set('TestGroup', result);

      testRunner.displayTestDetails(testNode);

      expect(channelService.appendLine).toHaveBeenCalledWith(
        'We are unable to complete this test run because the test results do not contain any test cases.'
      );
    });
  });

  describe('displayTestDetails with FAILED status', () => {
    it('should display test case details for Agentforce Studio test with individual test case', () => {
      const testGroup = new AgentTestGroupNode('TestGroup');
      const testNode = new AgentTestNode('#1');
      testNode.parentName = 'TestGroup';

      const result = {
        id: 'test-run-id',
        status: 'FAILED',
        testCases: [
          {
            testNumber: '1',
            testScorerResults: [
              {
                scorerName: 'Quality',
                scorerResponse: JSON.stringify({ status: 'PASS', score: 5, reasoning: 'Good' })
              }
            ]
          }
        ]
      };

      // @ts-ignore - accessing private property for testing
      testRunner.agentforceStudioTestGroupNameToResult.set('TestGroup', result);

      testRunner.displayTestDetails(testNode);

      expect(channelService.appendLine).toHaveBeenCalledWith('CASE #1');
      expect(channelService.appendLine).toHaveBeenCalledWith('❯ QUALITY: PASS ✅');
    });
  });

  describe('printTestSummary', () => {
    it('should display error message when testCases is empty', () => {
      const result = {
        id: 'test-run-id',
        status: 'COMPLETED',
        testCases: []
      };

      // @ts-ignore - calling private method for testing
      testRunner.printTestSummary(result);

      expect(channelService.appendLine).toHaveBeenCalledWith('COMPLETED');
      expect(channelService.appendLine).toHaveBeenCalledWith(
        'We are unable to complete this test run because the test results do not contain any test cases.'
      );
    });

    it('should display test results when testCases has data', () => {
      const result = {
        id: 'test-run-id',
        status: 'COMPLETED',
        testCases: [
          {
            testNumber: '1',
            testResults: [{ result: 'PASS', name: 'test1', actualValue: 'a', expectedValue: 'a', score: 1 }]
          },
          {
            testNumber: '2',
            testResults: [{ result: 'FAILURE', name: 'test2', actualValue: 'b', expectedValue: 'c', score: 0 }]
          }
        ]
      };

      // @ts-ignore - calling private method for testing
      testRunner.printTestSummary(result);

      expect(channelService.appendLine).toHaveBeenCalledWith('COMPLETED');
      expect(channelService.appendLine).toHaveBeenCalledWith('Test Results');
      expect(channelService.appendLine).toHaveBeenCalledWith('Passing: 1/2');
      expect(channelService.appendLine).toHaveBeenCalledWith('Failing: 1/2');
    });
  });

  describe('printAgentforceStudioTestSummary', () => {
    it('should display error message when testCases is empty', () => {
      const result = {
        id: 'test-run-id',
        status: 'FAILED',
        testCases: []
      };

      // @ts-ignore - calling private method for testing
      testRunner.printAgentforceStudioTestSummary(result);

      expect(channelService.appendLine).toHaveBeenCalledWith('FAILED');
      expect(channelService.appendLine).toHaveBeenCalledWith(
        'We are unable to complete this test run because the test results do not contain any test cases.'
      );
    });

    it('should display test results when testCases has data', () => {
      const result = {
        id: 'test-run-id',
        status: 'COMPLETED',
        testCases: [
          {
            testNumber: '1',
            testScorerResults: [
              {
                scorerName: 'Quality',
                scorerResponse: JSON.stringify({ status: 'PASS', score: 5, reasoning: 'Good' })
              }
            ]
          },
          {
            testNumber: '2',
            testScorerResults: [
              {
                scorerName: 'Latency',
                scorerResponse: JSON.stringify({ status: 'FAIL', latencyMs: 5000, reasoning: 'Too slow' })
              }
            ]
          }
        ]
      };

      // @ts-ignore - calling private method for testing
      testRunner.printAgentforceStudioTestSummary(result);

      expect(channelService.appendLine).toHaveBeenCalledWith('COMPLETED');
      expect(channelService.appendLine).toHaveBeenCalledWith('Test Results');
      expect(channelService.appendLine).toHaveBeenCalledWith('Passing: 1/2');
      expect(channelService.appendLine).toHaveBeenCalledWith('Failing: 1/2');
    });
  });

  describe('displayAgentforceStudioTestCases', () => {
    it('should display error message when testCases is empty', () => {
      const testInfo = {
        id: 'test-run-id',
        status: 'COMPLETED',
        testCases: []
      };

      // @ts-ignore - calling private method for testing
      testRunner.displayAgentforceStudioTestCases(testInfo);

      expect(channelService.appendLine).toHaveBeenCalledWith(
        'We are unable to complete this test run because the test results do not contain any test cases.'
      );
    });

    it('should display test case details when testCases has data', () => {
      const testInfo = {
        id: 'test-run-id',
        status: 'COMPLETED',
        testCases: [
          {
            testNumber: '1',
            testScorerResults: [
              {
                scorerName: 'Quality',
                scorerResponse: JSON.stringify({ status: 'PASS', score: 5, reasoning: 'Good quality' })
              }
            ]
          }
        ]
      };

      // @ts-ignore - calling private method for testing
      testRunner.displayAgentforceStudioTestCases(testInfo);

      expect(channelService.appendLine).toHaveBeenCalledWith('CASE #1');
      expect(channelService.appendLine).toHaveBeenCalledWith('❯ QUALITY: PASS ✅');
    });

    it('should display assertion scorer details correctly', () => {
      const testInfo = {
        id: 'test-run-id',
        status: 'COMPLETED',
        testCases: [
          {
            testNumber: '1',
            testScorerResults: [
              {
                scorerName: 'Assertion',
                scorerResponse: JSON.stringify({ actualValue: 'test', expectedValue: 'test' })
              }
            ]
          }
        ]
      };

      // @ts-ignore - calling private method for testing
      testRunner.displayAgentforceStudioTestCases(testInfo);

      expect(channelService.appendLine).toHaveBeenCalledWith('CASE #1');
      expect(channelService.appendLine).toHaveBeenCalledWith('❯ ASSERTION: PASS ✅');
      expect(channelService.appendLine).toHaveBeenCalledWith('EXPECTED : test');
      expect(channelService.appendLine).toHaveBeenCalledWith('ACTUAL   : test');
    });
  });
});
