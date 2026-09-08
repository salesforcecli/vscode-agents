import React, { useState, useCallback } from 'react';
import { Timeline, TimelineItemProps } from '../shared/Timeline.js';
import './TraceHistoryRow.css';

interface PlanSuccessResponse {
  type: string;
  planId: string;
  sessionId: string;
  intent?: string;
  topic?: string;
  plan: unknown[];
}

export interface TraceHistoryRowProps {
  /** The trace entry data */
  entry: {
    storageKey: string;
    agentId: string;
    sessionId: string;
    planId: string;
    messageId?: string;
    userMessage?: string;
    timestamp?: string;
    trace: PlanSuccessResponse;
  };
  /** Index of this row in the list */
  index: number;
  /** Whether this row is currently expanded */
  isExpanded: boolean;
  /** Callback when expand state changes */
  onExpandedChange: (expanded: boolean) => void;
  /** Callback to open raw JSON */
  onOpenJson: () => void;
  /** Timeline items for this entry */
  timelineItems: TimelineItemProps[];
  /** Message string for header display */
  message: string;
  /** Currently selected step index in this row's timeline */
  selectedStepIndex?: number;
}

export const TraceHistoryRow: React.FC<TraceHistoryRowProps> = ({
  entry,
  index,
  isExpanded,
  onExpandedChange,
  onOpenJson,
  timelineItems,
  message,
  selectedStepIndex
}) => {
  const contentId = `trace-history-content-${index}`;

  const handleHeaderClick = () => {
    onExpandedChange(!isExpanded);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onExpandedChange(!isExpanded);
    }
  };

  const traceData = entry.trace;

  const handleJsonClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onOpenJson();
  };

  const [copiedField, setCopiedField] = useState<string | null>(null);

  const handleCopyValue = useCallback((field: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  }, []);

  const CopyButton: React.FC<{ field: string; value: string }> = ({ field, value }) => (
    <button
      type="button"
      className={`tracer-info-table__copy-btn${copiedField === field ? ' tracer-info-table__copy-btn--copied' : ''}`}
      onClick={() => handleCopyValue(field, value)}
      aria-label="Copy"
      data-tooltip={copiedField === field ? 'Copied!' : 'Copy'}
    >
      <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path d="M1.97333 2.98667L2.98666 1.97333H8.37333L12 5.54667V12.96L10.9867 13.9733H2.98666L1.97333 12.96V2.98667ZM10.9867 5.97333L7.99999 2.98667H2.98666V12.96H10.9867V5.97333ZM0.959994 -9.53674e-07L-5.72205e-06 0.959999V10.9867L0.959994 12V0.959999H7.41333L6.39999 -9.53674e-07H0.959994Z" />
      </svg>
    </button>
  );

  return (
    <div className={`trace-history-row ${isExpanded ? 'trace-history-row--expanded' : ''}`}>
      <div className="trace-history-row__header-wrapper">
        <button
          type="button"
          className="trace-history-row__header"
          onClick={handleHeaderClick}
          onKeyDown={handleKeyDown}
          aria-expanded={isExpanded}
          aria-controls={contentId}
        >
          <svg
            width="8"
            height="5"
            viewBox="0 0 8 5"
            fill="currentColor"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
            className={`trace-history-row__chevron ${isExpanded ? 'trace-history-row__chevron--expanded' : ''}`}
          >
            <path d="M4 3.56L7.24 0.279999L7.72 0.76L4.2 4.24H3.76L0.24 0.76L0.72 0.279999L4 3.56Z" />
          </svg>
          <span className="trace-history-row__header-content">
            <span className="trace-history-row__message">{message}</span>
          </span>
        </button>
        <button
          type="button"
          className="trace-history-row__action-icon trace-history-row__json-icon"
          onClick={handleJsonClick}
          aria-label="Open JSON"
          data-tooltip="Open JSON"
        >
          <svg width="15" height="14" viewBox="0 0 15 14" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
            <path d="M5.01333 4.90666L7.04 2.82666V2.13333L4.90666 -2.86102e-06L4.21333 0.69333L5.49333 1.97333H2.50666C1.79555 1.97333 1.19111 2.22222 0.693331 2.72C0.231108 3.21777 -2.86102e-06 3.82222 -2.86102e-06 4.53333C-2.86102e-06 5.20889 0.231108 5.79555 0.693331 6.29333C1.19111 6.75555 1.79555 6.98666 2.50666 6.98666H2.98666V5.97333H2.50666C2.08 5.97333 1.72444 5.83111 1.44 5.54666C1.15555 5.26222 0.995553 4.90666 0.959997 4.48C0.959997 4.05333 1.10222 3.69777 1.38666 3.41333C1.70666 3.12889 2.08 2.98666 2.50666 2.98666H5.49333L4.21333 4.26666L4.90666 4.96L5.01333 4.90666ZM9.97333 0.959997H7.30666L6.29333 -2.86102e-06H10.9867L11.68 0.266664L14.72 3.25333L14.9867 4V12.96L13.9733 13.9733H5.01333L4 12.96V5.49333L5.01333 6.34666V12.96H13.9733V4.96H9.97333V0.959997ZM10.9867 0.959997V4H13.9733L10.9867 0.959997Z" />
          </svg>
        </button>
      </div>

      {isExpanded && (
        <div id={contentId} className="trace-history-row__content">
          <table className="tracer-info-table">
            <tbody>
              <tr>
                <td className="tracer-info-table__label">Session ID</td>
                <td className="tracer-info-table__value tracer-info-table__value--copyable">
                  {traceData.sessionId}
                  <CopyButton field="sessionId" value={traceData.sessionId} />
                </td>
              </tr>
              <tr>
                <td className="tracer-info-table__label">Plan ID</td>
                <td className="tracer-info-table__value tracer-info-table__value--copyable">
                  {traceData.planId}
                  <CopyButton field="planId" value={traceData.planId} />
                </td>
              </tr>
              {entry.timestamp && (
                <tr>
                  <td className="tracer-info-table__label">Timestamp</td>
                  <td className="tracer-info-table__value">{new Date(entry.timestamp).toLocaleString()}</td>
                </tr>
              )}
            </tbody>
          </table>

          <div className="trace-history-row__timeline">
            <Timeline items={timelineItems} selectedIndex={selectedStepIndex} />
          </div>
        </div>
      )}
    </div>
  );
};

export default TraceHistoryRow;
