import React from "react";
import styles from "./MainApp.module.css";

const ServerIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
    <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
    <line x1="6" y1="6" x2="6.01" y2="6"></line>
    <line x1="6" y1="18" x2="6.01" y2="18"></line>
  </svg>
);

const MessageIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
  </svg>
);

const BackIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

const SettingsIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"></circle>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
  </svg>
);


function NavigationBar({ activeView, onViewChange, unreadDMs, unreadServers, onBack }) {
  return (
    <div className={styles.navBarCluster}>
      {onBack ? (
        <div className={`${styles.navBackPill} frosted-glass`}>
          <button
            type="button"
            className={styles.navBackButton}
            onClick={onBack}
            aria-label="Back to server list"
          >
            <BackIcon />
          </button>
        </div>
      ) : null}
      <div className={`${styles.navOverlay} frosted-glass`}>
      <div className={styles.navOverlayTabs}>
      <button 
        className={`${styles.navItem} ${activeView === 'dms' ? styles.navItemActive : ''}`}
        onClick={() => onViewChange('dms')}
        aria-label="Direct Messages"
      >
        <div style={{ position: 'relative' }}>
          <MessageIcon />
          {unreadDMs > 0 && (
            <span style={{
              position: 'absolute',
              top: -4,
              right: -8,
              background: 'var(--red)',
              color: 'white',
              fontSize: '10px',
              fontWeight: 700,
              padding: '2px 4px',
              borderRadius: '8px',
              minWidth: '16px',
              textAlign: 'center'
            }}>
              {unreadDMs > 99 ? '99+' : unreadDMs}
            </span>
          )}
        </div>
        <span style={{ fontSize: '12px', fontWeight: 600 }}>DMs</span>
      </button>

      <button 
        className={`${styles.navItem} ${activeView === 'servers' ? styles.navItemActive : ''}`}
        onClick={() => onViewChange('servers')}
        aria-label="Servers"
      >
        <div style={{ position: 'relative' }}>
          <ServerIcon />
          {unreadServers > 0 && (
            <span style={{
              position: 'absolute',
              top: -4,
              right: -8,
              background: 'var(--red)',
              color: 'white',
              fontSize: '10px',
              fontWeight: 700,
              padding: '2px 4px',
              borderRadius: '8px',
              minWidth: '16px',
              textAlign: 'center'
            }}>
              {unreadServers > 99 ? '99+' : unreadServers}
            </span>
          )}
        </div>
        <span style={{ fontSize: '12px', fontWeight: 600 }}>Servers</span>
      </button>

      <button 
        className={`${styles.navItem} ${activeView === 'settings' ? styles.navItemActive : ''}`}
        onClick={() => onViewChange('settings')}
        aria-label="Settings"
      >
        <SettingsIcon />
        <span style={{ fontSize: '12px', fontWeight: 600 }}>Settings</span>
      </button>
      </div>
      </div>
    </div>
  );
}

export default React.memo(NavigationBar);
