import React, { useState, useEffect, useRef, useCallback } from 'react';
import AgentPreview, { AgentPreviewRef } from './components/AgentPreview/AgentPreview.js';
import AgentTracer from './components/AgentTracer/AgentTracer.js';
import AgentSelector from './components/AgentPreview/AgentSelector.js';
import SessionHistory from './components/SessionHistory/SessionHistory.js';
import TabNavigation from './components/shared/TabNavigation.js';
import { Button } from './components/shared/Button.js';
import { vscodeApi, AgentInfo, AgentSource } from './services/vscodeApi.js';
import './App.css';

interface SelectAgentMessage {
  agentId: string;
  forceRestart?: boolean;
  agentSource?: string;
}

declare global {
  interface Window {
    __agentforceDXAppTestHooks?: {
      waitForSessionEnd: () => Promise<void>;
      setSessionActiveFlag: (active: boolean) => void;
      getPendingStartResolvers: () => number;
      getDisplayedAgentId: () => string;
    };
  }
}

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'preview' | 'tracer' | 'history'>('preview');
  const [displayedAgentId, setDisplayedAgentIdState] = useState('');
  const [desiredAgentId, setDesiredAgentId] = useState('');
  const [restartTrigger, setRestartTrigger] = useState(0);
  const [isSessionTransitioning, setIsSessionTransitioning] = useState(false);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [isSessionStarting, setIsSessionStarting] = useState(false);
  const [isStopPending, setIsStopPending] = useState(false);
  const [hasSessionError, setHasSessionError] = useState(false);
  const [isPreviewingSession, setIsPreviewingSession] = useState(false);
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [selectedAgentInfo, setSelectedAgentInfo] = useState<AgentInfo | null>(null);
  const [hasAgents, setHasAgents] = useState(false);
  const [isLoadingAgents, setIsLoadingAgents] = useState(true);
  const [authError, setAuthError] = useState<{ message: string; details?: string; setupUrl?: string } | null>(null);
  const sessionChangeQueueRef = useRef(Promise.resolve());
  const displayedAgentIdRef = useRef<string>('');
  const desiredAgentIdRef = useRef<string>('');
  const forceRestartRef = useRef(false);
  const sessionActiveRef = useRef(false);
  const isSessionTransitioningRef = useRef(false);
  const sessionEndResolversRef = useRef<Array<() => void>>([]);
  const sessionStartResolversRef = useRef<Array<(success: boolean) => void>>([]);
  const agentPreviewRef = useRef<AgentPreviewRef>(null);

  useEffect(() => {
    displayedAgentIdRef.current = displayedAgentId;
  }, [displayedAgentId]);

  useEffect(() => {
    desiredAgentIdRef.current = desiredAgentId;
  }, [desiredAgentId]);

  useEffect(() => {
    isSessionTransitioningRef.current = isSessionTransitioning;
  }, [isSessionTransitioning]);

  useEffect(() => {
    const disposeSelectAgent = vscodeApi.onMessage('selectAgent', (data: SelectAgentMessage) => {
      if (!data || typeof data.agentId === 'undefined') {
        return;
      }

      // Update the selected agent in the dropdown (even when clearing selection)
      setDesiredAgentId(data.agentId);
      // Pass agentSource to avoid expensive re-fetch on the backend
      vscodeApi.setSelectedAgentId(data.agentId, data.agentSource as AgentSource | undefined);

      if (data.agentId === '') {
        // Clear the view immediately when the provider resets the selection
        vscodeApi.clearMessages();
        return;
      }

      if (data.forceRestart) {
        // Restart Agent button clicked - force immediate restart
        forceRestartRef.current = true;
        setRestartTrigger(prev => prev + 1);
      }
      // History is now loaded atomically by setSelectedAgentId handler
      // No need for separate loadAgentHistory call
    });

    const disposeRefreshAgents = vscodeApi.onMessage('refreshAgents', () => {
      // Switch back to preview tab when refreshing agents
      setActiveTab('preview');
      setAuthError(null);
      sessionActiveRef.current = false;
      setIsSessionActive(false);
      setIsSessionStarting(false);
      setIsStopPending(false);
    });

    const disposeSetLiveMode = vscodeApi.onMessage('setLiveMode', (data: { isLiveMode: boolean }) => {
      if (data && typeof data.isLiveMode === 'boolean') {
        setIsLiveMode(data.isLiveMode);
      }
    });

    // Test command handlers for integration tests
    const disposeTestStartSession = vscodeApi.onMessage('testStartSession', (data: { agentId?: string; isLiveMode?: boolean }) => {
      const agentId = data?.agentId || desiredAgentIdRef.current;
      const liveMode = data?.isLiveMode !== undefined ? data.isLiveMode : isLiveMode;
      
      if (agentId) {
        console.log('[Webview Test] testStartSession received:', { agentId, isLiveMode: liveMode });
        // Set live mode if provided
        if (data?.isLiveMode !== undefined) {
          setIsLiveMode(liveMode);
        }
        // Trigger session start by setting desired agent and forcing restart
        setDesiredAgentId(agentId);
        forceRestartRef.current = true;
        setRestartTrigger(prev => prev + 1);
      } else {
        console.warn('[Webview Test] testStartSession: No agentId provided');
      }
    });

    const disposeTestSendMessage = vscodeApi.onMessage('testSendMessage', (data: { message: string }) => {
      const message = data?.message;
      if (message && agentPreviewRef.current) {
        console.log('[Webview Test] testSendMessage received:', message);
        // Use the ref to send message - we need to expose a method on AgentPreviewRef
        // For now, we'll trigger it through the component's handleSendMessage
        // We'll need to add a method to AgentPreviewRef for this
        agentPreviewRef.current.sendMessage?.(message);
      } else {
        console.warn('[Webview Test] testSendMessage: No message or agentPreviewRef not available');
      }
    });

    const disposeTestEndSession = vscodeApi.onMessage('testEndSession', () => {
      console.log('[Webview Test] testEndSession received');
      vscodeApi.endSession();
    });

    const disposeTestGetTrace = vscodeApi.onMessage('testGetTrace', () => {
      console.log('[Webview Test] testGetTrace received');
      vscodeApi.getTraceData();
    });

    const disposeTestSwitchTab = vscodeApi.onMessage('testSwitchTab', (data: { tab: 'preview' | 'tracer' | 'history' }) => {
      const tab = data?.tab || 'preview';
      console.log('[Webview Test] testSwitchTab received:', tab);
      setActiveTab(tab);
    });

    const disposeAuthError = vscodeApi.onMessage('authError', (data: { message: string; details?: string; setupUrl?: string }) => {
      setAuthError({ message: data.message, details: data.details, setupUrl: data.setupUrl });
      setIsLoadingAgents(false);
    });

    // Request initial live mode state from extension
    vscodeApi.getInitialLiveMode();

    return () => {
      disposeSelectAgent();
      disposeRefreshAgents();
      disposeSetLiveMode();
      disposeAuthError();
      disposeTestStartSession();
      disposeTestSendMessage();
      disposeTestEndSession();
      disposeTestGetTrace();
      disposeTestSwitchTab();
    };
  }, []);

  const handleTabChange = (tab: 'preview' | 'tracer' | 'history') => {
    setActiveTab(tab);
  };

  const handleLiveModeChange = useCallback((isLive: boolean) => {
    setIsLiveMode(isLive);
    // Notify the provider to persist the selection
    vscodeApi.setLiveMode(isLive);
  }, []);

  // Track when the backend pushes a "loaded conversation" so the start button
  // can switch between Resume and Start. The setConversation message includes
  // previewSessionInfo when a prior session's transcript is being shown.
  const isSessionStartingRef = useRef(false);
  useEffect(() => {
    isSessionStartingRef.current = isSessionStarting;
  }, [isSessionStarting]);

  useEffect(() => {
    return vscodeApi.onMessage('setConversation', (data: any) => {
      const info = data?.previewSessionInfo;
      const messages = Array.isArray(data?.messages) ? data.messages : [];
      if (info && typeof info.sessionId === 'string') {
        setIsPreviewingSession(true);
        // Preview has landed; the stopping transition started by a history
        // row click is over. Clear the stop-pending flag so the button can
        // settle on its Resume label.
        setIsStopPending(false);
        if (info.sessionType === 'simulated') {
          setIsLiveMode(false);
        } else if (info.sessionType === 'live' || info.sessionType === 'published') {
          setIsLiveMode(true);
        }
      } else if (messages.length > 0) {
        // A conversation with messages but no preview info means a non-resumable
        // load (e.g. legacy auto-load). Drop the preview flag.
        setIsPreviewingSession(false);
      } else if (!isSessionStartingRef.current) {
        // Empty conversation, no preview info, not in a stopping transition:
        // this is an explicit clear (toolbar action). Drop the preview flag so
        // the start button reverts to "Start Simulation/Live Test".
        setIsPreviewingSession(false);
      }
      // Else: empty + null + sessionStarting=true means we're mid-stop. Leave
      // isPreviewingSession alone so Resume label stays put.
    });
  }, []);


  // Switch to preview tab when a published agent is selected (tracer not supported)
  // or when no agent is selected
  useEffect(() => {
    if (activeTab === 'tracer') {
      if (selectedAgentInfo?.type === AgentSource.PUBLISHED || !desiredAgentId) {
        setActiveTab('preview');
      }
    }
  }, [selectedAgentInfo, activeTab, desiredAgentId]);

  // Switch to preview tab when the agent changes while viewing history
  useEffect(() => {
    if (activeTab === 'history') {
      setActiveTab('preview');
    }
  }, [desiredAgentId]);

  const handleGoToPreview = useCallback(() => {
    // If session is not active and we have a desired agent, start the session
    if (!isSessionActive && !isSessionStarting && desiredAgentId) {
      forceRestartRef.current = true;
      setRestartTrigger(prev => prev + 1);
    }

    setActiveTab('preview');
    // Small delay to ensure tab is visible before focusing
    setTimeout(() => {
      agentPreviewRef.current?.focusInput();
    }, 100);
  }, [isSessionActive, isSessionStarting, desiredAgentId]);

  const handleAgentChange = useCallback((agentId: string, agentSource?: AgentSource) => {
    setDesiredAgentId(agentId);
    setIsPreviewingSession(false);
    // Notify the extension about the selected agent
    // Pass agentSource to avoid expensive re-fetch on the backend
    // History is now loaded atomically by setSelectedAgentId handler
    vscodeApi.setSelectedAgentId(agentId, agentSource);
  }, []);

  const handleStopSession = useCallback(() => {
    // Optimistic update: immediately update UI state before backend confirms
    sessionActiveRef.current = false;
    setIsSessionActive(false);
    setIsSessionStarting(false);
    // Mark the stop as in flight so the Start button stays disabled until
    // sessionEnded arrives. We deliberately don't set isSessionTransitioning
    // here because that would trigger the "Connecting to agent..." loader in
    // AgentPreview while the user is actually stopping.
    setIsStopPending(true);
  }, []);

  const handleStartSession = useCallback(() => {
    // Route Start through the restart queue so isSessionTransitioning stays
    // true continuously from click through sessionStarted, preventing a
    // flicker where the chat area goes blank between click and backend ack.
    // Also set the transition flag synchronously here so the loading state
    // appears on the very next render, instead of waiting for the queue
    // microtask + the network round-trip to sessionStarting.
    setActiveTab('preview');
    setIsSessionStarting(true);
    setIsSessionTransitioning(true);
    forceRestartRef.current = true;
    setRestartTrigger(prev => prev + 1);
  }, []);

  const handleAgentsAvailabilityChange = useCallback((hasAgentsAvailable: boolean, isLoading: boolean) => {
    setHasAgents(hasAgentsAvailable);
    setIsLoadingAgents(isLoading);
  }, []);

  useEffect(() => {
    const disposeSessionStarted = vscodeApi.onMessage('sessionStarted', (data: any) => {
      sessionActiveRef.current = true;
      setIsSessionActive(true);
      setIsSessionStarting(false);
      setIsPreviewingSession(false);
      if (data && typeof data === 'object' && typeof data.sessionId === 'string') {
        activeSessionIdRef.current = data.sessionId;
      }
      const resolver = sessionStartResolversRef.current.shift();
      if (resolver) {
        resolver(true);
      }
    });

    const disposeSessionEnded = vscodeApi.onMessage('sessionEnded', (data: any) => {
      sessionActiveRef.current = false;
      isSessionStartingRef.current = false;
      setIsSessionActive(false);
      setIsSessionStarting(false);
      // If the backend marked the just-ended session as previewable, flip
      // into preview mode so the toolbar shows Resume + Clear without
      // touching the chat messages already on screen.
      const info = data?.previewSessionInfo;
      if (info && typeof info.sessionId === 'string') {
        setIsPreviewingSession(true);
        if (info.sessionType === 'simulated') {
          setIsLiveMode(false);
        } else if (info.sessionType === 'live' || info.sessionType === 'published') {
          setIsLiveMode(true);
        }
      }
      // Else: don't clear isPreviewingSession here. The setConversation
      // listener owns that flag. When sessionEnded fires after a history-row
      // click, a preview is still loaded and Resume should remain available.
      setIsStopPending(false);
      activeSessionIdRef.current = undefined;
      const resolver = sessionEndResolversRef.current.shift();
      if (resolver) {
        resolver();
      }
    });

    const disposeSessionStarting = vscodeApi.onMessage('sessionStarting', (data: any) => {
      sessionActiveRef.current = false;
      // Update the ref synchronously so the setConversation listener (which
      // may fire on the same message-bus tick) sees the new value before
      // React's state-driven effect catches up.
      isSessionStartingRef.current = true;
      setIsSessionActive(false);
      setIsSessionStarting(true);
      // Don't clear isStopPending during a stopping-for-preview transition,
      // or the toolbar button briefly flips to Start before the preview
      // lands and reveals Resume.
      const isStoppingTransition = typeof data?.message === 'string' && /stopping/i.test(data.message);
      if (!isStoppingTransition) {
        setIsStopPending(false);
      }
      // Switch to preview tab when starting a new session
      setActiveTab('preview');
    });

    const disposeSessionError = vscodeApi.onMessage('error', () => {
      sessionActiveRef.current = false;
      setIsSessionActive(false);
      setIsSessionStarting(false);
      setIsStopPending(false);
      const endResolver = sessionEndResolversRef.current.shift();
      if (endResolver) {
        endResolver();
      }
      const startResolver = sessionStartResolversRef.current.shift();
      if (startResolver) {
        startResolver(false);
      }
    });

    const disposeCompilationError = vscodeApi.onMessage('compilationError', () => {
      sessionActiveRef.current = false;
      setIsSessionActive(false);
      setIsSessionStarting(false);
      setIsStopPending(false);
      const startResolver = sessionStartResolversRef.current.shift();
      if (startResolver) {
        startResolver(false);
      }
    });

    const disposeClearMessages = vscodeApi.onMessage('clearMessages', () => {
      // The backend sends clearMessages immediately before sessionStarting at
      // the start of a (re)start. Don't clear isSessionStarting mid-restart,
      // or the Start/Stop button briefly re-enables and the loading state
      // gets a visible discontinuity.
      if (!isSessionTransitioningRef.current) {
        setIsSessionStarting(false);
      }
    });

    return () => {
      disposeSessionStarted();
      disposeSessionEnded();
      disposeSessionStarting();
      disposeSessionError();
      disposeCompilationError();
      disposeClearMessages();
    };
  }, []);

  const waitForSessionEnd = useCallback(() => {
    if (!sessionActiveRef.current) {
      return Promise.resolve();
    }

    return new Promise<void>(resolve => {
      sessionEndResolversRef.current.push(resolve);
    });
  }, []);

  const waitForSessionStart = useCallback(() => {
    return new Promise<boolean>(resolve => {
      sessionStartResolversRef.current.push(resolve);
    });
  }, []);

  const handleSessionTransitionSettled = useCallback(() => {
    setIsSessionTransitioning(false);
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV === 'test' && typeof window !== 'undefined') {
      window.__agentforceDXAppTestHooks = {
        waitForSessionEnd,
        setSessionActiveFlag: (active: boolean) => {
          sessionActiveRef.current = active;
        },
        getPendingStartResolvers: () => sessionStartResolversRef.current.length,
        getDisplayedAgentId: () => displayedAgentIdRef.current
      };
      return () => {
        delete window.__agentforceDXAppTestHooks;
      };
    }
  }, [waitForSessionEnd]);

  useEffect(() => {
    sessionChangeQueueRef.current = sessionChangeQueueRef.current
      .then(async () => {
        const shouldForceRestart = forceRestartRef.current;
        forceRestartRef.current = false;

        const previousAgentId = displayedAgentIdRef.current;
        const nextAgentId = desiredAgentIdRef.current;
        const hasExistingAgent = previousAgentId !== '';
        const hasTargetAgent = nextAgentId !== '';
        const changingAgents = shouldForceRestart || previousAgentId !== nextAgentId;

        if (!changingAgents && !hasExistingAgent && !hasTargetAgent) {
          return;
        }

        if (changingAgents || shouldForceRestart) {
          setIsSessionTransitioning(true);
        }

        if (hasExistingAgent && (changingAgents || shouldForceRestart) && sessionActiveRef.current) {
          const waitForEnd = waitForSessionEnd();
          // Tell the backend this end is part of a restart (mode switch or
          // agent change) so it skips marking the session as previewable.
          // Otherwise the upcoming startSession would route through resume.
          vscodeApi.endSession({ restarting: true });
          await waitForEnd;
        }

        if (!hasTargetAgent) {
          setDisplayedAgentIdState('');
          handleSessionTransitionSettled();
          return;
        }

        // Handle session start based on context:
        // - shouldForceRestart = true (play/refresh button): Start session immediately
        // - shouldForceRestart = false (dropdown selection): Let history flow handle it
        if (shouldForceRestart && hasTargetAgent) {
          // Play/refresh button clicked - start session immediately
          const waitForStart = waitForSessionStart();
          vscodeApi.startSession(nextAgentId, { isLiveMode });
          const startSucceeded = await waitForStart;

          if (startSucceeded) {
            setDisplayedAgentIdState(nextAgentId);
          }
        } else if (hasTargetAgent && changingAgents) {
          // Dropdown selection - just update UI, history flow handles session start
          setDisplayedAgentIdState(nextAgentId);
        }

        handleSessionTransitionSettled();
      })
      .catch(err => {
        console.error('Error managing agent session:', err);
        handleSessionTransitionSettled();
      });
  }, [
    desiredAgentId,
    restartTrigger,
    waitForSessionEnd,
    waitForSessionStart,
    handleSessionTransitionSettled,
    isLiveMode
  ]);

  const previewAgentId = desiredAgentId !== '' ? desiredAgentId : displayedAgentId;
  const pendingAgentId = desiredAgentId !== displayedAgentId ? desiredAgentId : null;

  if (authError) {
    return (
      <div className="app">
        <div className="app-content">
          <div className="agent-preview">
            <div className="agent-preview-error">
              <div className="agent-preview-error-icon" />
              <p className="agent-preview-error-message">{authError.message}</p>
              {authError.details && <p className="agent-preview-error-details">{authError.details}</p>}
              <div className="agent-preview-error-buttons">
                <Button appearance="secondary" size="small" onClick={() => {
                  vscodeApi.executeCommand('sf.set.default.org');
                }}>
                  Select Another Org
                </Button>
                {authError.setupUrl && (
                  <Button appearance="primary" size="small" onClick={() => {
                    vscodeApi.openUrl(authError.setupUrl!);
                  }}>
                    Enable Agentforce
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="app-menu" style={hasSessionError ? { display: 'none' } : undefined}>
        <AgentSelector
          selectedAgent={desiredAgentId}
          onAgentChange={handleAgentChange}
          isSessionActive={isSessionActive}
          isSessionStarting={isSessionStarting}
          isSessionTransitioning={isSessionTransitioning || isStopPending}
          isStopPending={isStopPending}
          onLiveModeChange={handleLiveModeChange}
          initialLiveMode={isLiveMode}
          onSelectedAgentInfoChange={setSelectedAgentInfo}
          onStopSession={handleStopSession}
          onStartSession={handleStartSession}
          onAgentsAvailabilityChange={handleAgentsAvailabilityChange}
          isPreviewingSession={isPreviewingSession}
        />
        <div className="app-menu-divider" />
        {previewAgentId !== '' && !isSessionStarting && !isStopPending && (
          <TabNavigation
            activeTab={activeTab}
            onTabChange={handleTabChange}
            showTracerTab={selectedAgentInfo?.type !== AgentSource.PUBLISHED}
            showHistoryTab={true}
          />
        )}
      </div>
      <div className="app-content">
        <div className={`tab-content ${activeTab === 'preview' ? 'active' : 'hidden'}`}>
          <AgentPreview
            ref={agentPreviewRef}
            isSessionTransitioning={isSessionTransitioning}
            onSessionTransitionSettled={handleSessionTransitionSettled}
            selectedAgentId={previewAgentId}
            pendingAgentId={pendingAgentId}
            isSessionActive={isSessionActive}
            isStopPending={isStopPending}
            onStartSession={handleStartSession}
            onHasSessionError={setHasSessionError}
            isLiveMode={isLiveMode}
            selectedAgentInfo={selectedAgentInfo}
            onLiveModeChange={handleLiveModeChange}
            hasAgents={hasAgents}
            isLoadingAgents={isLoadingAgents}
          />
        </div>
        <div className={`tab-content ${activeTab === 'tracer' ? 'active' : 'hidden'}`}>
          <AgentTracer
            isVisible={activeTab === 'tracer'}
            onGoToPreview={handleGoToPreview}
            isSessionActive={isSessionActive}
            isLiveMode={isLiveMode}
            selectedAgentInfo={selectedAgentInfo}
            onLiveModeChange={handleLiveModeChange}
          />
        </div>
        <div className={`tab-content ${activeTab === 'history' ? 'active' : 'hidden'}`}>
          <SessionHistory
            agentId={previewAgentId}
            agentSource={selectedAgentInfo?.type}
            isActive={activeTab === 'history'}
            isSessionActive={isSessionActive}
            isLiveMode={isLiveMode}
            selectedAgentInfo={selectedAgentInfo}
            onResume={() => {
              setIsPreviewingSession(true);
              setActiveTab('preview');
            }}
            onPreviewStart={() => {
              // History row clicked while a session is active. Mirror the
              // optimistic Stop flow so the toolbar button keeps its Stop
              // label across the stopping transition until the preview lands.
              setIsStopPending(true);
            }}
            onGoToPreview={handleGoToPreview}
            onLiveModeChange={handleLiveModeChange}
          />
        </div>
      </div>
    </div>
  );
};

export default App;
