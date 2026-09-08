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

import { ChannelService } from '../types/ChannelService';
import { SfError } from '@salesforce/core';

export type LogLevel = 'error' | 'warn' | 'debug';

/**
 * Additional, loosely-typed fields that may appear on API/HTTP-style errors
 * (e.g. from jsforce) but are not part of the `SfError` type definition.
 */
interface ErrorWithApiDetails {
  data?: unknown;
  response?: unknown;
  body?: unknown;
  statusCode?: unknown;
  code?: unknown;
}

/**
 * Formats a log message with timestamp and status indicator
 * Format: [MM-DD-YYYY HH:MM:SS.sss] [STATUS] message
 */
function formatLogMessage(level: LogLevel, message: string): string {
  const timestamp = new Date().toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: false
  });

  const statusMap: Record<LogLevel, string> = {
    error: '[error]',
    warn: '[warn]',
    debug: '[debug]'
  };

  return `[${timestamp}] ${statusMap[level]} ${message}`;
}

/**
 * Logger utility for structured logging with timestamps and status indicators
 */
export class Logger {
  constructor(private readonly channelService: ChannelService) {}

  /**
   * Log an error message with optional stack trace and API response
   * @param message - The error message to log
   * @param error - Optional SfError instance containing error details
   */
  error(message: string, error?: SfError): void {
    this.channelService.appendLine(formatLogMessage('error', message));

    if (error) {
      if (error.message && error.message !== message) {
        this.channelService.appendLine(formatLogMessage('error', `  Details: ${error.message}`));
      }

      // Try to extract API response data from SfError
      const errorDetails: ErrorWithApiDetails = error;
      if (errorDetails.data || errorDetails.response || errorDetails.body) {
        this.channelService.appendLine(formatLogMessage('error', '  API Response:'));
        try {
          const responseData = errorDetails.data || errorDetails.response || errorDetails.body;
          const responseStr = typeof responseData === 'string' ? responseData : JSON.stringify(responseData, null, 2);
          // Indent each line of the response
          responseStr.split('\n').forEach(line => {
            this.channelService.appendLine(formatLogMessage('error', `    ${line}`));
          });
        } catch {
          this.channelService.appendLine(
            formatLogMessage('error', `    ${String(errorDetails.data || errorDetails.response || errorDetails.body)}`)
          );
        }
      }

      // Log status code if available
      if (errorDetails.statusCode || errorDetails.code) {
        this.channelService.appendLine(
          formatLogMessage('error', `  Status Code: ${errorDetails.statusCode || errorDetails.code}`)
        );
      }

      if (error.stack) {
        // Indent stack trace for readability
        const stackLines = error.stack.split('\n').slice(1); // Skip first line (message)
        stackLines.forEach(line => {
          this.channelService.appendLine(formatLogMessage('error', `  ${line.trim()}`));
        });
      }
    }
  }

  /**
   * Log a warning message
   */
  warn(message: string): void {
    this.channelService.appendLine(formatLogMessage('warn', message));
  }

  /**
   * Log a debug message
   */
  debug(message: string): void {
    this.channelService.appendLine(formatLogMessage('debug', message));
  }

  /**
   * Log a raw line without formatting (for backward compatibility with test output)
   */
  appendLine(message: string): void {
    this.channelService.appendLine(message);
  }

  /**
   * Log additional error details as continuation of previous error message
   */
  errorDetail(message: string): void {
    const indent = '\t'; // Single tab for clean indentation
    this.channelService.appendLine(`${indent}${message}`);
  }

  /**
   * Show the channel output
   */
  show(): void {
    this.channelService.showChannelOutput();
  }

  /**
   * Clear the channel
   */
  clear(): void {
    this.channelService.clear();
  }
}
