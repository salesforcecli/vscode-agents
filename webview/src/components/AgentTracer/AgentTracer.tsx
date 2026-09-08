import React, { useState, useEffect, useCallback } from 'react';
import TracerPlaceholder from './TracerPlaceholder.js';
import { TimelineItemProps, TimelineIconName } from '../shared/Timeline.js';
import { CodeBlock } from '../shared/CodeBlock.js';
import TabNavigation from '../shared/TabNavigation.js';
import SystemMessage from '../AgentPreview/SystemMessage.js';
import { TraceHistoryRow } from './TraceHistoryRow.js';

import { vscodeApi, AgentInfo } from '../../services/vscodeApi.js';
import './AgentTracer.css';
import './TraceHistoryRow.css';

interface AgentTracerProps {
  isVisible?: boolean;
  onGoToPreview?: () => void;
  isSessionActive?: boolean;
  isLiveMode?: boolean;
  selectedAgentInfo?: AgentInfo | null;
  onLiveModeChange?: (isLive: boolean) => void;
}

interface TraceStepFunctionData {
  name?: string;
  output?: unknown;
}

interface TraceStepData {
  agent_name?: string;
  directive_context?: string;
  enabled_tools?: unknown[];
  execution_latency?: number;
  variable_updates?: Array<{ variable_name?: string }>;
  from_agent?: string;
  to_agent?: string;
  [key: string]: unknown;
}

// A single step within a trace plan. Step shapes vary by `type`/`stepType`,
// so most fields are optional; the index signature allows for additional
// fields we don't explicitly model but may still surface (e.g. via
// JSON.stringify-based filtering).
export interface TracePlanStep {
  type?: string;
  stepType?: string;
  name?: string;
  label?: string;
  description?: string;
  message?: string;
  data?: TraceStepData;
  reason?: string;
  topic?: string;
  responseType?: string;
  isContentSafe?: boolean;
  safetyScore?: number;
  function?: TraceStepFunctionData;
  generatedResponse?: unknown;
  instructionAdherence?: string;
  [key: string]: unknown;
}

// PlanSuccessResponse format from AgentSimulate.trace()
interface PlanSuccessResponse {
  type: string;
  planId: string;
  sessionId: string;
  intent?: string;
  topic?: string;
  plan: TracePlanStep[];
}

export interface TraceHistoryEntry {
  storageKey: string;
  agentId: string;
  sessionId: string;
  planId: string;
  messageId?: string;
  userMessage?: string;
  timestamp?: string;
  trace: PlanSuccessResponse;
}

export const isTraceErrorMessage = (message?: string): boolean => {
  if (!message || typeof message !== 'string') {
    return false;
  }
  const lowered = message.toLowerCase();
  return lowered.includes('trace') || lowered.includes('plan id') || lowered.includes('session');
};

const formatTime = (date: Date): string => {
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12; // Convert to 12-hour format, 0 becomes 12
  return `${hours}:${minutes}:${seconds} ${ampm}`;
};

export const formatHistoryLabel = (entry: TraceHistoryEntry, index: number, maxLength?: number): string => {
  let baseLabel = entry.userMessage || (entry.messageId ? `Message ${index + 1}` : `Trace ${index + 1}`);

  // Truncate baseLabel if maxLength is specified (for dropdown options)
  if (maxLength !== undefined && baseLabel.length > maxLength) {
    baseLabel = baseLabel.substring(0, maxLength) + '...';
  }

  if (!entry.timestamp) {
    return baseLabel;
  }
  const date = new Date(entry.timestamp);
  if (Number.isNaN(date.getTime())) {
    return baseLabel;
  }
  const time = formatTime(date);
  return `${time} • ${baseLabel}`;
};

export const formatHistoryParts = (
  entry: TraceHistoryEntry,
  index: number
): { time: string | null; message: string } => {
  const baseLabel = entry.userMessage || (entry.messageId ? `Message ${index + 1}` : `Trace ${index + 1}`);

  if (!entry.timestamp) {
    return { time: null, message: baseLabel };
  }
  const date = new Date(entry.timestamp);
  if (Number.isNaN(date.getTime())) {
    return { time: null, message: baseLabel };
  }
  const time = formatTime(date);
  return { time, message: baseLabel };
};

export const selectHistoryEntry = (entries: TraceHistoryEntry[], index: number): PlanSuccessResponse | null => {
  if (index < 0 || index >= entries.length) {
    return null;
  }
  return entries[index].trace ?? null;
};

export const translateStepIndexToFiltered = (
  plan: TracePlanStep[] | undefined,
  originalStepIndex: number | null,
  filterQuery: string
): number | undefined => {
  if (originalStepIndex === null || originalStepIndex === undefined) {
    return undefined;
  }
  if (!Array.isArray(plan)) {
    return undefined;
  }
  const trimmed = (filterQuery ?? '').trim();
  if (!trimmed) {
    return originalStepIndex;
  }

  let filteredIndex = -1;
  for (let i = 0; i < plan.length; i++) {
    if (stepMatchesFilter(plan[i], trimmed)) {
      filteredIndex++;
      if (i === originalStepIndex) {
        return filteredIndex;
      }
    }
  }
  return undefined;
};

export const stepMatchesFilter = (step: TracePlanStep, query: string): boolean => {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return true;
  }
  const stepType = step?.type || step?.stepType || '';
  const displayName = STEP_DISPLAY_NAMES[stepType] || stepType;
  if (displayName && displayName.toLowerCase().includes(trimmed)) {
    return true;
  }
  try {
    if (JSON.stringify(step).toLowerCase().includes(trimmed)) {
      return true;
    }
  } catch {
    // ignore stringify failures (e.g. circular refs)
  }
  return false;
};

export const entryMetadataMatches = (entry: TraceHistoryEntry, query: string): boolean => {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return true;
  }
  if (entry.userMessage && entry.userMessage.toLowerCase().includes(trimmed)) {
    return true;
  }
  if (entry.sessionId && entry.sessionId.toLowerCase().includes(trimmed)) {
    return true;
  }
  if (entry.planId && entry.planId.toLowerCase().includes(trimmed)) {
    return true;
  }
  return false;
};

export const matchesTraceFilter = (entry: TraceHistoryEntry, query: string): boolean => {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return true;
  }

  if (entryMetadataMatches(entry, trimmed)) {
    return true;
  }

  const plan = entry.trace?.plan;
  if (!Array.isArray(plan)) {
    return false;
  }

  return plan.some(step => stepMatchesFilter(step, trimmed));
};

export const applyHistorySelection = (
  entries: TraceHistoryEntry[],
  preferredIndex: number | null
): { nextIndex: number | null; nextTraceData: PlanSuccessResponse | null } => {
  if (entries.length === 0) {
    return { nextIndex: null, nextTraceData: null };
  }

  const targetIndex =
    preferredIndex !== null && preferredIndex >= 0 && preferredIndex < entries.length
      ? preferredIndex
      : entries.length - 1;

  return {
    nextIndex: targetIndex,
    nextTraceData: entries[targetIndex].trace
  };
};

// Map step types to user-friendly display names
const STEP_DISPLAY_NAMES: Record<string, string> = {
  UserInputStep: 'User Input',
  SessionInitialStateStep: 'Session Initialized',
  NodeEntryStateStep: 'Subagent Selected',
  EnabledToolsStep: 'Tools Enabled',
  LLMStep: 'Reasoning',
  VariableUpdateStep: 'Variable Update',
  TransitionStep: 'Subagent Transition',
  BeforeReasoningStep: 'Before Reasoning',
  BeforeReasoningIterationStep: 'Before Reasoning Iteration',
  ReasoningStep: 'Reasoning',
  OutputEvaluationStep: 'Output Evaluation',
  PlannerResponseStep: 'Agent Response',
  UpdateTopicStep: 'Subagent Selected',
  FunctionStep: 'Action Executed',
  GuardrailsStep: 'Guardrails Check'
};

// Map step types to icons (VS Code icons)
const STEP_ICONS: Record<string, TimelineIconName> = {
  UserInputStep: 'account',
  SessionInitialStateStep: 'debug-start',
  NodeEntryStateStep: 'check-all',
  EnabledToolsStep: 'tools',
  LLMStep: 'lightbulb',
  VariableUpdateStep: 'symbol-namespace',
  TransitionStep: 'arrow-right',
  BeforeReasoningStep: 'checklist',
  BeforeReasoningIterationStep: 'checklist',
  ReasoningStep: 'lightbulb',
  OutputEvaluationStep: 'search',
  PlannerResponseStep: 'agent',
  UpdateTopicStep: 'tag',
  FunctionStep: 'action',
  GuardrailsStep: 'shield'
};

// Get the description/subtitle for a step based on its type
const getStepDescription = (step: TracePlanStep): string | undefined => {
  const stepType = step.type || step.stepType || '';

  switch (stepType) {
    case 'UserInputStep':
      return step.message || undefined;

    case 'SessionInitialStateStep':
      return step.data?.directive_context || undefined;

    case 'NodeEntryStateStep':
      return step.data?.agent_name || undefined;

    case 'EnabledToolsStep': {
      const tools = step.data?.enabled_tools;
      if (Array.isArray(tools) && tools.length > 0) {
        return `${tools.length} tool${tools.length > 1 ? 's' : ''} for ${step.data?.agent_name || 'agent'}`;
      }
      return step.data?.agent_name || undefined;
    }

    case 'LLMStep': {
      const agentName = step.data?.agent_name;
      const latency = step.data?.execution_latency;
      if (agentName && latency) {
        return `${agentName} (${latency}ms)`;
      }
      return agentName || undefined;
    }

    case 'VariableUpdateStep': {
      const updates = step.data?.variable_updates;
      if (Array.isArray(updates) && updates.length > 0) {
        const varNames = updates.map(u => u.variable_name).filter(Boolean);
        if (varNames.length === 1) {
          return varNames[0];
        }
        if (varNames.length > 1) {
          return `${varNames.length} variables updated`;
        }
      }
      return undefined;
    }

    case 'TransitionStep': {
      const from = step.data?.from_agent;
      const to = step.data?.to_agent;
      if (from && to) {
        return `${from} → ${to}`;
      }
      return undefined;
    }

    case 'BeforeReasoningStep':
      return step.data?.agent_name || undefined;

    case 'ReasoningStep': {
      const reason = step.reason;
      if (reason) {
        // Extract the category (text before the colon)
        const colonIndex = reason.indexOf(':');
        if (colonIndex > 0 && colonIndex < 30) {
          return reason.substring(0, colonIndex);
        }
        return reason;
      }
      return undefined;
    }

    case 'PlannerResponseStep': {
      const message = step.message;
      if (message) {
        return message;
      }
      return undefined;
    }

    case 'UpdateTopicStep':
      return step.topic || undefined;

    case 'FunctionStep':
      return step.function?.name || undefined;

    case 'GuardrailsStep': {
      // instructionAdherence is a multi-line string starting with a level
      // like "HIGH" / "MEDIUM" / "LOW", followed by an explanation. Surface
      // just the level on the timeline.
      const adherence = step.instructionAdherence;
      if (typeof adherence === 'string' && adherence.length > 0) {
        const firstLine = adherence.split('\n')[0].trim();
        return firstLine || undefined;
      }
      return undefined;
    }

    default:
      return undefined;
  }
};

export const buildTimelineItems = (
  traceData: PlanSuccessResponse | null,
  onSelect: (index: number) => void,
  filterQuery?: string
): TimelineItemProps[] => {
  if (!traceData || !traceData.plan) {
    return [];
  }

  const trimmedFilter = filterQuery?.trim() ?? '';

  const items = traceData.plan.map((step, index: number) => {
    const stepType = step.type || step.stepType || '';
    const stepName = step.name || step.label || step.description || '';

    // Determine status - FunctionStep without output indicates an error
    let status: 'success' | 'error' | 'pending' | 'incomplete' = 'success';
    if (stepType === 'FunctionStep' && step.function && !step.function.output) {
      status = 'error';
    }

    // Get user-friendly display name
    const displayType = STEP_DISPLAY_NAMES[stepType] || stepType;

    // Get icon for this step type
    const icon = STEP_ICONS[stepType];

    let label: string;
    if (stepType && stepName) {
      label = `${displayType}: ${stepName}`;
    } else if (stepType) {
      label = displayType;
    } else if (stepName) {
      label = stepName;
    } else {
      label = `Step ${index + 1}`;
    }

    const description = getStepDescription(step);
    const hasData =
      step &&
      (step.data || step.message || step.reason || step.function || step.generatedResponse || step.instructionAdherence);

    return {
      status,
      label,
      description,
      icon,
      onClick: hasData ? () => onSelect(index) : undefined,
      _step: step
    } as TimelineItemProps & { _step: TracePlanStep };
  });

  if (!trimmedFilter) {
    return items.map(({ _step, ...item }) => item);
  }

  return items
    .filter(item => stepMatchesFilter(item._step, trimmedFilter))
    .map(({ _step, ...item }) => item);
};

export const getStepData = (traceData: PlanSuccessResponse | null, selectedStepIndex: number | null): string | null => {
  if (selectedStepIndex === null || !traceData || !traceData.plan) {
    return null;
  }

  const step = traceData.plan[selectedStepIndex];
  if (!step) {
    return null;
  }

  // Build a display object with relevant step properties
  const displayData: Record<string, unknown> = {};

  if (step.data) {
    Object.assign(displayData, step.data);
  }
  if (step.message) {
    displayData.message = step.message;
  }
  if (step.reason) {
    displayData.reason = step.reason;
  }
  if (step.topic) {
    displayData.topic = step.topic;
  }
  if (step.responseType) {
    displayData.responseType = step.responseType;
  }
  if (step.isContentSafe !== undefined) {
    displayData.isContentSafe = step.isContentSafe;
  }
  if (step.safetyScore) {
    displayData.safetyScore = step.safetyScore;
  }
  if (step.function) {
    displayData.function = step.function;
  }
  if (step.generatedResponse) {
    displayData.generatedResponse = step.generatedResponse;
  }
  if (step.instructionAdherence) {
    displayData.instructionAdherence = step.instructionAdherence;
  }

  if (Object.keys(displayData).length > 0) {
    return JSON.stringify(displayData, null, 2);
  }

  return null;
};

const AgentTracer: React.FC<AgentTracerProps> = ({
  isVisible = true,
  onGoToPreview,
  isSessionActive = false,
  isLiveMode = false,
  selectedAgentInfo = null,
  onLiveModeChange
}) => {
  const [traceData, setTraceData] = useState<PlanSuccessResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedStepIndex, setSelectedStepIndex] = useState<number | null>(null);
  const [selectedHistoryIndex, setSelectedHistoryIndex] = useState<number | null>(null);
  const [panelHeight, setPanelHeight] = useState<number>(300);
  const [isResizing, setIsResizing] = useState<boolean>(false);
  const [traceHistory, setTraceHistory] = useState<TraceHistoryEntry[]>([]);
  const [expandedPlanIds, setExpandedPlanIds] = useState<Set<string>>(new Set());
  const [filterQuery, setFilterQuery] = useState<string>('');

  const handleRowExpandedChange = useCallback((planId: string, expanded: boolean) => {
    setExpandedPlanIds(prev => {
      const next = new Set(prev);
      if (expanded) {
        next.add(planId);
      } else {
        next.delete(planId);
      }
      return next;
    });
  }, []);

  const handleRowStepSelect = useCallback(
    (historyIndex: number, stepIndex: number) => {
      // Set the trace data to the selected entry's trace for the step panel
      const entry = traceHistory[historyIndex];
      if (entry) {
        setTraceData(entry.trace);
      }
      setSelectedHistoryIndex(historyIndex);
      setSelectedStepIndex(stepIndex);
    },
    [traceHistory]
  );

  const handleRowOpenJson = useCallback((entry: TraceHistoryEntry) => {
    vscodeApi.openTraceJson(entry);
  }, []);

  const requestTraceData = useCallback(() => {
    setLoading(true);
    setError(null);
    vscodeApi.getTraceData();
  }, []);

  useEffect(() => {
    // Listen for trace data response
    const disposeTraceData = vscodeApi.onMessage('traceData', (data: PlanSuccessResponse) => {
      setTraceData(data);
      setLoading(false);
      setError(null);

      // Send test response when trace data is received (for integration tests)
      vscodeApi.postTestMessage('testTraceDataReceived', {
        hasPlanId: !!data?.planId,
        hasSessionId: !!data?.sessionId,
        planStepCount: data?.plan?.length || 0,
        traceData: data
      });
    });

    // Listen for errors
    const disposeError = vscodeApi.onMessage('error', (data?: { message?: string }) => {
      if (data?.message && isTraceErrorMessage(data.message)) {
        setError(data.message);
        setLoading(false);
      }
    });

    // Listen for messageSent events to refresh trace data
    const disposeMessageSent = vscodeApi.onMessage('messageSent', () => {
      // Wait a bit for the planId to be set in the provider before requesting
      setTimeout(() => {
        requestTraceData();
      }, 200);
    });

    // Clear trace history when a new session starts
    const disposeSessionStarted = vscodeApi.onMessage('sessionStarted', () => {
      setTraceHistory([]);
      setTraceData(null);
      setSelectedStepIndex(null);
      setSelectedHistoryIndex(null);
      setExpandedPlanIds(new Set());
      setFilterQuery('');
    });

    // Request trace data when component mounts
    requestTraceData();

    const disposeTraceHistory = vscodeApi.onMessage('traceHistory', (data?: { entries?: TraceHistoryEntry[] }) => {
      const entries: TraceHistoryEntry[] = Array.isArray(data?.entries) ? data.entries : [];

      // Handle empty state
      if (entries.length === 0) {
        setTraceHistory([]);
        setTraceData(null);
        setSelectedStepIndex(null);
        setSelectedHistoryIndex(null);
        setExpandedPlanIds(new Set());
        setFilterQuery('');
        setLoading(false);
        vscodeApi.postTestMessage('testTraceHistoryReceived', { entryCount: 0, entries: [] });
        return;
      }

      // Use entries directly from backend - trust backend order
      setTraceHistory(entries);

      // Set trace data to the latest entry for the step panel
      const latestEntry = entries[entries.length - 1];
      setTraceData(latestEntry.trace);
      setSelectedStepIndex(null);
      setSelectedHistoryIndex(null);
      setFilterQuery('');

      // Expand only the latest entry (collapse others)
      setExpandedPlanIds(new Set([latestEntry.planId]));

      setLoading(false);
      vscodeApi.postTestMessage('testTraceHistoryReceived', { entryCount: entries.length, entries });
    });

    return () => {
      disposeTraceData();
      disposeError();
      disposeMessageSent();
      disposeSessionStarted();
      disposeTraceHistory();
    };
  }, [requestTraceData]);

  // Request trace data when the tracer tab becomes visible
  useEffect(() => {
    if (isVisible) {
      requestTraceData();
    }
  }, [isVisible, requestTraceData]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newHeight = window.innerHeight - e.clientY;
      if (newHeight >= 100 && newHeight <= window.innerHeight * 0.8) {
        setPanelHeight(newHeight);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  if (error) {
    return (
      <div className="agent-tracer">
        <div className="tracer-error">{error}</div>
      </div>
    );
  }

  // Determine if we have trace data - check traceHistory for collapsible rows
  const hasTraceHistory = traceHistory.length > 0;
  const shouldShowPlaceholder = !hasTraceHistory;
  const selectedStepData = getStepData(traceData, selectedStepIndex);

  const trimmedFilter = filterQuery.trim();
  const filteredEntries = trimmedFilter
    ? traceHistory
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => matchesTraceFilter(entry, trimmedFilter))
    : traceHistory.map((entry, index) => ({ entry, index }));
  const hasFilterMatches = filteredEntries.length > 0;

  const totalStepCount = traceHistory.reduce((sum, entry) => sum + (entry.trace?.plan?.length ?? 0), 0);
  const matchedStepCount = trimmedFilter
    ? filteredEntries.reduce((sum, { entry }) => {
        const plan = entry.trace?.plan ?? [];
        if (entryMetadataMatches(entry, trimmedFilter)) {
          return sum + plan.length;
        }
        return sum + plan.filter(step => stepMatchesFilter(step, trimmedFilter)).length;
      }, 0)
    : totalStepCount;

  // Handle panel resize
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  return (
    <div className="agent-tracer">
      <div className="tracer-content">
        {loading ? (
          <div className="tracer-loading">
            <span className="loading-spinner"></span>
            <span className="loading-text">Loading trace data...</span>
          </div>
        ) : hasTraceHistory ? (
          <div className="tracer-simple">
            <div className="trace-filter">
              <div className="trace-filter__input-wrapper">
                <input
                  type="text"
                  className={`trace-filter__input${trimmedFilter ? ' trace-filter__input--with-count' : ''}`}
                  placeholder="Filter traces by message, event type, or content"
                  value={filterQuery}
                  onChange={e => setFilterQuery(e.target.value)}
                  aria-label="Filter trace history"
                />
                {trimmedFilter && (
                  <span className="trace-filter__count" aria-live="polite">
                    {matchedStepCount} of {totalStepCount}
                  </span>
                )}
                {filterQuery && (
                  <button
                    type="button"
                    className="trace-filter__clear"
                    onClick={() => setFilterQuery('')}
                    aria-label="Clear filter"
                    title="Clear filter"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                      <path d="M8 8.707l3.646 3.647.708-.708L8.707 8l3.647-3.646-.708-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
            {hasFilterMatches ? (
              <div className="trace-history-list" role="list" aria-label="Trace history">
                {filteredEntries.map(({ entry, index }) => {
                  const { message } = formatHistoryParts(entry, index);
                  const metadataMatches = !!trimmedFilter && entryMetadataMatches(entry, trimmedFilter);
                  const stepFilter = metadataMatches ? '' : trimmedFilter;
                  const timelineItems = buildTimelineItems(
                    entry.trace,
                    stepIndex => handleRowStepSelect(index, stepIndex),
                    stepFilter
                  );

                  const rowSelectedStepIndex =
                    selectedHistoryIndex === index
                      ? translateStepIndexToFiltered(entry.trace?.plan, selectedStepIndex, stepFilter)
                      : undefined;

                  return (
                    <TraceHistoryRow
                      key={entry.planId}
                      entry={entry}
                      index={index}
                      isExpanded={expandedPlanIds.has(entry.planId)}
                      onExpandedChange={expanded => handleRowExpandedChange(entry.planId, expanded)}
                      onOpenJson={() => handleRowOpenJson(entry)}
                      timelineItems={timelineItems}
                      message={message}
                      selectedStepIndex={rowSelectedStepIndex}
                    />
                  );
                })}
              </div>
            ) : (
              <div className="trace-filter__empty">No traces match "{trimmedFilter}"</div>
            )}
          </div>
        ) : shouldShowPlaceholder ? (
          <TracerPlaceholder
            onGoToPreview={onGoToPreview}
            isSessionActive={isSessionActive}
            isLiveMode={isLiveMode}
            selectedAgentInfo={selectedAgentInfo}
            onModeChange={onLiveModeChange}
          />
        ) : (
          <SystemMessage content="Unable to load trace data. Check the console for errors." type="error" />
        )}
      </div>

      {selectedStepIndex !== null && selectedStepData && (
        <div className="tracer-step-data-panel" style={{ height: `${panelHeight}px` }}>
          <div className="tracer-step-data-panel__resize-handle" onMouseDown={handleResizeStart} />
          <TabNavigation
            activeTab={0}
            onTabChange={() => {}}
            onClose={() => {
                  setSelectedStepIndex(null);
                  setSelectedHistoryIndex(null);
                }}
            tabs={[
              {
                id: 'json',
                label: 'JSON',
                icon: (
                  <svg
                    width="14"
                    height="11"
                    viewBox="0 0 14 11"
                    fill="currentColor"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M3.68 2.61333L2.98667 1.86667L0 4.90667V5.6L2.98667 8.58667L3.68 7.89333L1.06667 5.22667L3.68 2.61333ZM10.72 1.86667L13.7067 4.90667V5.6L10.72 8.58667L9.97333 7.89333L12.64 5.22667L9.97333 2.61333L10.72 1.86667ZM3.89333 10.0267L8.90667 0L9.81333 0.48L4.8 10.4533L3.89333 10.0267Z"
                      fill="currentColor"
                    />
                  </svg>
                )
              }
            ]}
          />
          <div className="tracer-step-data-panel__content">
            <CodeBlock code={selectedStepData!} highlight="json" showCopy={false} />
          </div>
        </div>
      )}
    </div>
  );
};

export default AgentTracer;
