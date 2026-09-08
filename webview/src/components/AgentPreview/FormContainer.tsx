import React, { forwardRef } from 'react';
import ChatInput, { ChatInputRef } from './ChatInput.js';
import './FormContainer.css';

// React is required for JSX transform in test environment
void React;

interface Message {
  id: string;
  type: 'user' | 'agent' | 'system';
  content: string;
  systemType?: 'session' | 'debug' | 'error' | 'warning';
  timestamp?: string;
}

interface FormContainerProps {
  onSendMessage: (message: string) => void;
  sessionActive: boolean; // Now represents agent connection status
  isLoading: boolean;
  messages?: Message[];
  isLiveMode?: boolean;
}

const FormContainer = forwardRef<ChatInputRef, FormContainerProps>(
  ({ onSendMessage, sessionActive, isLoading, messages = [], isLiveMode = false }, ref) => {
    return (
      <div className="form-container">
        <ChatInput
          ref={ref}
          onSendMessage={onSendMessage}
          disabled={!sessionActive || isLoading}
          isLoading={isLoading}
          messages={messages}
          isLiveMode={isLiveMode}
        />
      </div>
    );
  }
);

FormContainer.displayName = 'FormContainer';

export default FormContainer;
