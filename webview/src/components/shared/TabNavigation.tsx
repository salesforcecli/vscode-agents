import React from 'react';
import './TabNavigation.css';

export interface Tab {
  id: string;
  label: string;
  icon?: React.ReactNode;
}

interface TabNavigationProps {
  activeTab: number | 'preview' | 'tracer' | 'history';
  onTabChange: (tab: any) => void;
  showTracerTab?: boolean;
  showHistoryTab?: boolean;
  tabs?: Tab[];
  onClose?: () => void;
}

const TabNavigation: React.FC<TabNavigationProps> = ({
  activeTab,
  onTabChange,
  showTracerTab = false,
  showHistoryTab = false,
  tabs,
  onClose
}) => {
  const tabRefs = React.useRef<{ [key: string]: HTMLButtonElement | null }>({});
  const [indicatorStyle, setIndicatorStyle] = React.useState({ width: 0, left: 0 });

  // Use custom tabs if provided, otherwise use default tabs
  const isCustomTabs = tabs && tabs.length > 0;

  const updateIndicator = React.useCallback(() => {
    if (isCustomTabs) {
      const activeTabElement = tabRefs.current[activeTab.toString()];
      if (activeTabElement) {
        setIndicatorStyle({
          width: activeTabElement.offsetWidth,
          left: activeTabElement.offsetLeft
        });
      }
    } else {
      const activeTabElement = tabRefs.current[activeTab as string];
      if (activeTabElement) {
        setIndicatorStyle({
          width: activeTabElement.offsetWidth,
          left: activeTabElement.offsetLeft
        });
      }
    }
  }, [activeTab, isCustomTabs, tabs]);

  React.useEffect(() => {
    updateIndicator();
  }, [updateIndicator, showTracerTab, showHistoryTab]);

  // Update indicator on window resize (for responsive behavior)
  React.useEffect(() => {
    const handleResize = () => {
      // Use requestAnimationFrame to ensure DOM has updated after CSS media queries apply
      requestAnimationFrame(() => {
        updateIndicator();
      });
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [updateIndicator]);

  const handleTabClick = (tab: any) => {
    onTabChange(tab);
  };

  return (
    <nav className="tab-navigation">
      <div className="tab-navigation-left">
        {isCustomTabs ? (
          // Render custom tabs
          <>
            {tabs.map((tab, index) => (
              <button
                key={tab.id}
                ref={el => {
                  tabRefs.current[index.toString()] = el;
                }}
                className={`tab ${activeTab === index ? 'active' : ''}`}
                onClick={() => handleTabClick(index)}
              >
                {tab.icon && <span className="tab-icon">{tab.icon}</span>}
                {tab.label}
              </button>
            ))}
          </>
        ) : (
          // Render default tabs
          <>
            <button
              ref={el => {
                tabRefs.current['preview'] = el;
              }}
              className={`tab ${activeTab === 'preview' ? 'active' : ''}`}
              onClick={() => handleTabClick('preview')}
            >
              <span className="tab-icon tab-icon-comment"></span>
              <span className="tab-label">
                <span className="tab-label-prefix">Agent </span>
                <span className="tab-label-main">Preview</span>
              </span>
            </button>
            {showTracerTab && (
              <button
                ref={el => {
                  tabRefs.current['tracer'] = el;
                }}
                className={`tab ${activeTab === 'tracer' ? 'active' : ''}`}
                onClick={() => handleTabClick('tracer')}
              >
                <span className="tab-icon tab-icon-tree"></span>
                <span className="tab-label">
                  <span className="tab-label-prefix">Agent </span>
                  <span className="tab-label-main">Tracer</span>
                </span>
              </button>
            )}
            {showHistoryTab && (
              <button
                ref={el => {
                  tabRefs.current['history'] = el;
                }}
                className={`tab ${activeTab === 'history' ? 'active' : ''}`}
                onClick={() => handleTabClick('history')}
              >
                <span className="tab-icon tab-icon-clock"></span>
                <span className="tab-label">
                  <span className="tab-label-main">History</span>
                </span>
              </button>
            )}
          </>
        )}
        {indicatorStyle.width > 0 && (
          <div
            className="tab-navigation-indicator"
            style={{
              width: `${indicatorStyle.width}px`,
              transform: `translateX(${indicatorStyle.left}px)`
            }}
          />
        )}
      </div>
      {onClose && (
        <button className="tab-navigation-close" onClick={onClose} aria-label="Close">
          <svg width="10" height="10" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M4.53333 5.44L0 0.906667L0.906667 0L5.44 4.53333L9.97333 0L10.88 0.906667L6.34667 5.44L10.88 9.97333L9.97333 10.88L5.44 6.34667L0.906667 10.88L0 9.97333L4.53333 5.44Z"
              fill="currentColor"
            />
          </svg>
        </button>
      )}
    </nav>
  );
};

export default TabNavigation;
