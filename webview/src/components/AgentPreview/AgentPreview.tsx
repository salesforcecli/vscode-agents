import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import ChatContainer from './ChatContainer.js';
import FormContainer from './FormContainer.js';
import PlaceholderContent from './PlaceholderContent.js';
import AgentPreviewPlaceholder from './AgentPreviewPlaceholder.js';
import { Button } from '../shared/Button.js';
import { vscodeApi, Message, AgentInfo } from '../../services/vscodeApi.js';
import { ChatInputRef } from './ChatInput.js';
import './AgentPreview.css';

export const STOPPING_SESSION_MESSAGE = 'Stopping session...';

interface AgentPreviewProps {
  isSessionTransitioning: boolean;
  onSessionTransitionSettled: () => void;
  pendingAgentId: string | null;
  selectedAgentId: string;
  isSessionActive?: boolean;
  isStopPending?: boolean;
  onStartSession?: () => void;
  onHasSessionError?: (hasError: boolean) => void;
  onLoadingChange?: (isLoading: boolean) => void;
  isLiveMode?: boolean;
  selectedAgentInfo?: AgentInfo | null;
  onLiveModeChange?: (isLive: boolean) => void;
  hasAgents?: boolean;
  isLoadingAgents?: boolean;
}

export interface AgentPreviewRef {
  focusInput: () => void;
  sendMessage?: (message: string) => void;
}

interface HistoryMessagePayload {
  id?: string;
  type?: 'user' | 'agent';
  content?: string;
  timestamp?: string;
}

interface ConversationHistoryData {
  messages?: HistoryMessagePayload[];
}

interface SetConversationData {
  messages?: HistoryMessagePayload[];
  showPlaceholder?: boolean;
}

interface NoHistoryFoundData {
  agentId?: string;
}

interface SessionStartedData {
  skipWelcome?: boolean;
  content?: string;
}

interface MessagePayload {
  message?: string;
}

interface MessageSentData {
  content?: string;
}

interface ErrorData {
  message?: string;
  details?: string;
}

export const normalizeHistoryMessage = (msg: HistoryMessagePayload): Message => ({
  id: msg?.id || `${msg?.timestamp ?? 'history'}-${Date.now()}`,
  type: msg?.type as 'user' | 'agent',
  content: msg?.content || '',
  timestamp: msg?.timestamp || new Date().toISOString()
});

export const pruneStartingSessionMessages = (messages: Message[]): Message[] =>
  messages.filter(message => !(message.type === 'system' && message.content === 'Starting session...'));

export const createSystemMessage = (
  message?: string,
  systemType: Message['systemType'] = 'debug',
  details?: string
): Message | null => {
  if (!message) {
    return null;
  }

  return {
    id: Date.now().toString(),
    type: 'system',
    content: message,
    systemType,
    details,
    timestamp: new Date().toISOString()
  };
};

export const shouldShowTransitionLoader = (pendingAgentId?: string | null, selectedAgentId?: string): boolean => {
  return !pendingAgentId || pendingAgentId === selectedAgentId || selectedAgentId === '';
};

export const hasAgentSelection = (selectedAgentId?: string): boolean => Boolean(selectedAgentId);


const AgentPreview = forwardRef<AgentPreviewRef, AgentPreviewProps>(
  (
    {
      isSessionTransitioning,
      onSessionTransitionSettled,
      pendingAgentId,
      selectedAgentId,
      isSessionActive: parentIsSessionActive = false,
      isStopPending = false,
      onStartSession: parentOnStartSession,
      onHasSessionError,
      onLoadingChange,
      isLiveMode = false,
      selectedAgentInfo = null,
      onLiveModeChange,
      hasAgents = false,
      isLoadingAgents = true
    },
    ref
  ) => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [sessionActive, setSessionActive] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [loadingMessage, setLoadingMessage] = useState('Loading...');
    const [agentConnected, setAgentConnected] = useState(false);
    const [hasSessionError, setHasSessionError] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string>('');
    const [errorDetails, setErrorDetails] = useState<string | undefined>(undefined);
    const [showPlaceholder, setShowPlaceholder] = useState(false);
    const sessionErrorTimestampRef = React.useRef<number>(0);
    const sessionActiveStateRef = React.useRef(false);
    const hasSessionErrorRef = React.useRef(false);
    const previousSelectedAgentRef = React.useRef<string>('');
    const selectedAgentIdRef = React.useRef(selectedAgentId);
    const pendingAgentIdRef = React.useRef(pendingAgentId);
    const isSessionTransitioningRef = React.useRef(isSessionTransitioning);
    const chatInputRef = useRef<ChatInputRef>(null);
    const messagesRef = useRef<Message[]>([]);
    const agentInfoRef = useRef<AgentInfo | null>(selectedAgentInfo ?? null);

    // Expose focus method to parent components
    useImperativeHandle(ref, () => ({
      focusInput: () => {
        chatInputRef.current?.focus();
      },
      sendMessage: (message: string) => {
        handleSendMessage(message);
      }
    }));

    useEffect(() => {
      selectedAgentIdRef.current = selectedAgentId;
    }, [selectedAgentId]);

    useEffect(() => {
      pendingAgentIdRef.current = pendingAgentId;
    }, [pendingAgentId]);

    useEffect(() => {
      isSessionTransitioningRef.current = isSessionTransitioning;
    }, [isSessionTransitioning]);

    useEffect(() => {
      messagesRef.current = messages;
    }, [messages]);

    useEffect(() => {
      agentInfoRef.current = selectedAgentInfo ?? null;
    }, [selectedAgentInfo]);

    // Notify parent when session error state changes and keep ref in sync
    useEffect(() => {
      hasSessionErrorRef.current = hasSessionError;
      if (onHasSessionError) {
        onHasSessionError(hasSessionError);
      }
    }, [hasSessionError, onHasSessionError]);

    // Notify parent when loading state changes
    useEffect(() => {
      if (onLoadingChange) {
        onLoadingChange(isLoading);
      }
    }, [isLoading, onLoadingChange]);

    useEffect(() => {
      const disposers: Array<() => void> = [];

      const disposeClearMessages = vscodeApi.onMessage('clearMessages', () => {
        setMessages([]);
        setSessionActive(false);
        setAgentConnected(false);
        // Don't clear loading mid-restart: the backend sends clearMessages
        // immediately before sessionStarting, and dropping the loader between
        // them produces a one-frame blank chat area.
        if (!isSessionTransitioningRef.current) {
          setIsLoading(false);
        }
        setHasSessionError(false); // Clear error state when switching agents
        setShowPlaceholder(false); // Clear placeholder when switching agents
      });
      disposers.push(disposeClearMessages);

      const disposeConversationHistory = vscodeApi.onMessage('conversationHistory', (data?: ConversationHistoryData) => {
        if (data && Array.isArray(data.messages) && data.messages.length > 0) {
          const historyMessages: Message[] = data.messages.map(normalizeHistoryMessage);
          setMessages(historyMessages);
        } else {
          setMessages([]);
        }

        // History loaded - show it without starting session
        // User will manually click play button to start new session
        setSessionActive(false);
        setAgentConnected(false);
        setIsLoading(false);
      });
      disposers.push(disposeConversationHistory);

      // Atomic conversation state update - replaces separate clearMessages + conversationHistory
      // to avoid visual blink from sequential state updates
      const disposeSetConversation = vscodeApi.onMessage('setConversation', (data?: SetConversationData) => {
        // Atomically update all conversation-related state in one render
        const historyMessages: Message[] =
          data && Array.isArray(data.messages) ? data.messages.map(normalizeHistoryMessage) : [];

        setMessages(historyMessages);
        setSessionActive(false);
        setAgentConnected(false);
        setHasSessionError(false);
        // If we're mid-stop (sessionStarting=true), keep the loading spinner
        // and suppress the empty-state placeholder. The next setConversation
        // (with the previewed session's messages) will clear loading.
        setIsLoading(prev => {
          const explicitlyMidStop = prev && historyMessages.length === 0;
          if (!explicitlyMidStop) {
            setShowPlaceholder(data?.showPlaceholder ?? historyMessages.length === 0);
          } else {
            setShowPlaceholder(false);
          }
          return explicitlyMidStop ? true : false;
        });
      });
      disposers.push(disposeSetConversation);

      const disposeNoHistoryFound = vscodeApi.onMessage('noHistoryFound', (data?: NoHistoryFoundData) => {
        // No history found - show placeholder instead of auto-starting
        if (data && data.agentId) {
          setShowPlaceholder(true);
          setIsLoading(false);
        }
      });
      disposers.push(disposeNoHistoryFound);


      const disposeSessionStarted = vscodeApi.onMessage('sessionStarted', (data?: SessionStartedData) => {
        const timeSinceError = Date.now() - sessionErrorTimestampRef.current;
        if (sessionErrorTimestampRef.current > 0 && timeSinceError < 500) {
          console.warn('Ignoring sessionStarted that arrived too soon after error (race condition)');
          return;
        }

        sessionErrorTimestampRef.current = 0;
        sessionActiveStateRef.current = true;

        if (data && !data.skipWelcome) {
          setMessages(prev => {
            const newMessages = [...prev];

            // Add welcome message
            const welcomeMessage: Message = {
              id: (Date.now() + 1).toString(),
              type: 'agent',
              content: data.content || "Hi! I'm ready to help. What can I do for you?",
              timestamp: new Date().toISOString()
            };
            newMessages.push(welcomeMessage);

            return newMessages;
          });
        }

        setSessionActive(true);
        setAgentConnected(true);
        setIsLoading(false);
        setHasSessionError(false); // Clear error state when session successfully starts
        setShowPlaceholder(false); // Clear placeholder when session starts
        onSessionTransitionSettled();
      });
      disposers.push(disposeSessionStarted);

      const disposeSessionStarting = vscodeApi.onMessage('sessionStarting', (data?: MessagePayload) => {
        const currentSelectedAgentId = selectedAgentIdRef.current;
        const currentPendingAgentId = pendingAgentIdRef.current;
        const explicitMessage = typeof data?.message === 'string' ? data.message : undefined;

        setSessionActive(false);
        setAgentConnected(false);
        sessionActiveStateRef.current = false;
        sessionErrorTimestampRef.current = 0;

        if (currentSelectedAgentId === '') {
          setIsLoading(false);
          setMessages([]);
          return;
        }

        if (currentPendingAgentId && currentPendingAgentId === currentSelectedAgentId) {
          setIsLoading(true);
          setLoadingMessage(explicitMessage ?? 'Connecting to agent...');
        } else if (!currentPendingAgentId) {
          setIsLoading(true);
          setLoadingMessage(explicitMessage ?? 'Loading agent...');
          if (!explicitMessage) {
            setMessages([]);
          }
        } else {
          setIsLoading(false);
        }
      });
      disposers.push(disposeSessionStarting);

      const disposeCompilationStarting = vscodeApi.onMessage('compilationStarting', (data?: MessagePayload) => {
        setIsLoading(true);
        setLoadingMessage(data?.message || 'Compiling agent...');
      });
      disposers.push(disposeCompilationStarting);

      const disposeCompilationError = vscodeApi.onMessage('compilationError', (data?: MessagePayload) => {
        setIsLoading(false);
        setAgentConnected(false);
        sessionActiveStateRef.current = false;
        sessionErrorTimestampRef.current = Date.now();
        setHasSessionError(true);
        setErrorMessage('Compilation failed');
        setErrorDetails(data?.message || 'Failed to compile the agent.');
        setMessages(prev => pruneStartingSessionMessages(prev));
        onSessionTransitionSettled();
      });
      disposers.push(disposeCompilationError);

      const disposeSimulationStarting = vscodeApi.onMessage('simulationStarting', (data?: MessagePayload) => {
        setIsLoading(true);
        setLoadingMessage(data?.message || 'Starting simulation...');
      });
      disposers.push(disposeSimulationStarting);

      const disposeMessageSent = vscodeApi.onMessage('messageSent', (data?: MessageSentData) => {
        if (data && data.content) {
          const agentMessage: Message = {
            id: Date.now().toString(),
            type: 'agent',
            content: data.content,
            timestamp: new Date().toISOString()
          };
          setMessages(prev => [...prev, agentMessage]);
        }

        setIsLoading(false);
      });
      disposers.push(disposeMessageSent);

      const disposeMessageStarting = vscodeApi.onMessage('messageStarting', () => {
        setIsLoading(true);
        setLoadingMessage('Agent is thinking...');
      });
      disposers.push(disposeMessageStarting);

      const disposeError = vscodeApi.onMessage('error', (data?: ErrorData) => {
        setAgentConnected(false);
        sessionActiveStateRef.current = false;
        sessionErrorTimestampRef.current = Date.now();
        setHasSessionError(true);
        setErrorMessage(data?.message || 'Something went wrong');
        setErrorDetails(data?.details);
        setMessages(prev => pruneStartingSessionMessages(prev));
        setIsLoading(false);
        onSessionTransitionSettled();
      });
      disposers.push(disposeError);

      const disposeSessionEnded = vscodeApi.onMessage('sessionEnded', () => {
        setSessionActive(false);
        setAgentConnected(false);
        sessionActiveStateRef.current = false;
        // During a restart, sessionEnded is a midpoint, not the end of the
        // transition. Keep loading visible and don't settle the transition
        // flag yet, otherwise the chat area blanks between sessionEnded and
        // sessionStarting.
        if (!isSessionTransitioningRef.current) {
          setIsLoading(false);
          onSessionTransitionSettled();
        }
      });
      disposers.push(disposeSessionEnded);

      const disposeDebugLogProcessed = vscodeApi.onMessage('debugLogProcessed', (data?: MessagePayload) => {
        const logMessage = createSystemMessage(data?.message, 'debug');
        if (logMessage) {
          setMessages(prev => [...prev, logMessage]);
        }
      });
      disposers.push(disposeDebugLogProcessed);

      const disposeDebugLogError = vscodeApi.onMessage('debugLogError', (data?: MessagePayload) => {
        const errorMessage = createSystemMessage(data?.message, 'error');
        if (errorMessage) {
          setMessages(prev => [...prev, errorMessage]);
        }
      });
      disposers.push(disposeDebugLogError);

      return () => {
        disposers.forEach(dispose => dispose());
      };
    }, [onSessionTransitionSettled]);

    useEffect(() => {
      if (selectedAgentId === previousSelectedAgentRef.current) {
        return;
      }

      previousSelectedAgentRef.current = selectedAgentId;
      sessionActiveStateRef.current = false;
      setSessionActive(false);
      setAgentConnected(false);
      setShowPlaceholder(false); // Reset placeholder when agent changes

      if (selectedAgentId === '') {
        setIsLoading(false);
        setMessages([]);
        return;
      }

      // Don't clear messages here - let the backend's setConversation message
      // handle it atomically to avoid visual blink

      if (pendingAgentId && pendingAgentId === selectedAgentId) {
        setIsLoading(true);
        setLoadingMessage('Connecting to agent...');
      }
    }, [selectedAgentId, pendingAgentId]);

    useEffect(() => {
      if (isSessionTransitioning) {
        if (shouldShowTransitionLoader(pendingAgentId, selectedAgentId)) {
          setIsLoading(true);
          setLoadingMessage('Connecting to agent...');
          setAgentConnected(false);
        }
      } else if (shouldShowTransitionLoader(pendingAgentId, selectedAgentId)) {
        setIsLoading(false);
      }
    }, [isSessionTransitioning, pendingAgentId, selectedAgentId]);

    const handleSendMessage = (content: string) => {
      if (!agentConnected || !parentIsSessionActive || isStopPending || isSessionTransitioning) {
        return;
      }

      // Allow sending even when loading - let the backend handle message queuing
      const userMessage: Message = {
        id: Date.now().toString(),
        type: 'user',
        content,
        timestamp: new Date().toISOString()
      };
      setMessages(prev => [...prev, userMessage]);

      // Send message to VS Code
      vscodeApi.sendChatMessage(content);
    };

    // Watch for when selectedAgentId becomes empty (user selects default option)
    useEffect(() => {
      if (selectedAgentId === '') {
        // End any active session
        if (sessionActive || agentConnected) {
          vscodeApi.endSession();
        }
        // Reset to default welcome state
        setSessionActive(false);
        setIsLoading(false);
        setAgentConnected(false);
        setMessages([]);
        setShowPlaceholder(false);
      }
    }, [selectedAgentId, sessionActive, agentConnected]);

    const handleStartSession = () => {
      if (!hasAgentSelection(selectedAgentId)) {
        return;
      }
      setShowPlaceholder(false);
      // Route through the parent so App's session-transition state is
      // updated synchronously (button disables, loader appears immediately).
      // Fall back to the local path only if no parent handler was provided.
      if (parentOnStartSession) {
        parentOnStartSession();
      } else {
        setIsLoading(true);
        vscodeApi.startSession(selectedAgentId);
      }
    };

    const handleErrorReset = () => {
      setHasSessionError(false);
      setErrorMessage('');
      setErrorDetails(undefined);
      setShowPlaceholder(true);
      vscodeApi.executeCommand('sf.agent.combined.view.resetAgentView');
    };

    // Show error screen when session error occurred
    if (hasSessionError) {
      return (
        <div className="agent-preview">
          <div className="agent-preview-error">
            <div className="agent-preview-error-icon" />
            <p className="agent-preview-error-message">{errorMessage}</p>
            {errorDetails && <p className="agent-preview-error-details">{errorDetails}</p>}
            <Button appearance="primary" size="small" onClick={handleErrorReset}>
              Go Back
            </Button>
          </div>
        </div>
      );
    }

    // Show placeholder when no agent is selected
    if (selectedAgentId === '') {
      return (
        <div className="agent-preview">
          <PlaceholderContent hasAgents={hasAgents} isLoadingAgents={isLoadingAgents} />
        </div>
      );
    }

    // Show agent preview placeholder when agent is selected but has no history
    if (showPlaceholder && !isLoading && messages.length === 0) {
      return (
        <div className="agent-preview">
          <AgentPreviewPlaceholder
            onStartSession={handleStartSession}
            isLiveMode={isLiveMode}
            selectedAgentInfo={selectedAgentInfo}
            onModeChange={onLiveModeChange}
          />
          <FormContainer
            ref={chatInputRef}
            onSendMessage={handleSendMessage}
            sessionActive={false}
            isLoading={isLoading}
            messages={messages}
            isLiveMode={isLiveMode}
          />
        </div>
      );
    }

    // Input is enabled only when the parent confirms the session is active and
    // no stop/transition is in flight. This makes Stop disable the input
    // immediately on click, before the backend confirms sessionEnded.
    const inputEnabled = agentConnected && parentIsSessionActive && !isStopPending && !isSessionTransitioning;

    // While a Stop is in flight, mirror the "Connecting..." loader so the user
    // sees the chat-area spinner and a clear stopping message instead of a
    // frozen chat that still looks interactive.
    const showStopLoader = isStopPending && !isLoading;
    const effectiveIsLoading = isLoading || showStopLoader;
    const effectiveLoadingMessage = showStopLoader ? STOPPING_SESSION_MESSAGE : loadingMessage;

    // Hide the chat transcript while a Stop is in flight so the user sees only
    // the spinner and stopping message. Mirrors the empty-chat treatment during
    // session start.
    const visibleMessages = showStopLoader ? [] : messages;

    return (
      <div className="agent-preview">
        <ChatContainer messages={visibleMessages} isLoading={effectiveIsLoading} loadingMessage={effectiveLoadingMessage} />
        <FormContainer
          ref={chatInputRef}
          onSendMessage={handleSendMessage}
          sessionActive={inputEnabled}
          isLoading={effectiveIsLoading}
          messages={visibleMessages}
          isLiveMode={isLiveMode}
        />
      </div>
    );
  }
);

AgentPreview.displayName = 'AgentPreview';

export default AgentPreview;
