import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Button } from './Button.js';
import { vscodeApi } from '../../services/vscodeApi.js';
import './ErrorBoundary.css';

// React is required for JSX transform in test environment
void React;

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error boundary component that catches React errors and displays a fallback UI.
 * Prevents the entire view from going blank when a component crashes.
 * Also listens for reset commands from VS Code to recover from error state.
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private messageCleanups: Array<() => void> = [];

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  componentDidMount(): void {
    // Listen for reset/refresh commands from VS Code title bar
    this.messageCleanups.push(
      vscodeApi.onMessage('clearMessages', this.handleExternalReset),
      vscodeApi.onMessage('refreshAgents', this.handleExternalReset),
      vscodeApi.onMessage('selectAgent', this.handleExternalReset)
    );
  }

  componentWillUnmount(): void {
    this.messageCleanups.forEach(cleanup => cleanup());
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  handleExternalReset = (): void => {
    // Reset error state when receiving commands from VS Code
    if (this.state.hasError) {
      this.setState({ hasError: false, error: null });
    }
  };

  handleReset = (): void => {
    // Reset the error state and call the VS Code reset command
    this.setState({ hasError: false, error: null });
    vscodeApi.executeCommand('sf.agent.combined.view.resetAgentView');
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="error-boundary-fallback">
          <div className="error-boundary-icon" />
          <p>Something went wrong. Please try again.</p>
          {this.state.error?.message && (
            <p className="error-boundary-details">{this.state.error.message}</p>
          )}
          <Button appearance="primary" size="small" onClick={this.handleReset}>
            Go Back
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
