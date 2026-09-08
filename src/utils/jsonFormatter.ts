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

/**
 * Simplified JSON formatter extracted from oclif's colorizeJson functionality.
 * This version focuses only on prettifying JSON without colors.
 * Always formats with pretty printing (2-space indentation).
 */

function stringify(value: unknown, replacer?: unknown, spaces?: number): string {
  return JSON.stringify(value, serializer(replacer, replacer), spaces);
}

// Inspired by https://github.com/moll/json-stringify-safe
function serializer(replacer: unknown, cycleReplacer?: unknown) {
  const stack: unknown[] = [];
  const keys: string[] = [];

  if (!cycleReplacer) {
    cycleReplacer = function (_key: string, value: unknown) {
      if (stack[0] === value) return '[Circular ~]';
      return '[Circular ~.' + keys.slice(0, stack.indexOf(value)).join('.') + ']';
    };
  }

  return function (key: string, value: unknown) {
    if (stack.length > 0) {
      // @ts-expect-error because `this` is not typed
      const thisPos = stack.indexOf(this);
      if (~thisPos) {
        stack.splice(thisPos + 1);
      } else {
        // @ts-expect-error because `this` is not typed
        stack.push(this);
      }
      if (~thisPos) {
        keys.splice(thisPos, Number.POSITIVE_INFINITY, key);
      } else {
        keys.push(key);
      }
      // @ts-expect-error because `this` is not typed
      if (stack.includes(value)) value = cycleReplacer.call(this, key, value);
    } else {
      stack.push(value);
    }

    // @ts-expect-error because `this` is not typed
    return replacer ? replacer.call(this, key, value) : value;
  };
}

/**
 * Formats JSON input into a pretty-printed string with 2-space indentation.
 *
 * @param json - The JSON object or string to format
 * @returns Pretty-formatted JSON string
 */
export function formatJson(json: unknown): string {
  return stringify(typeof json === 'string' ? JSON.parse(json) : json, undefined, 2);
}
