import { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { SerialProvider } from './contexts/SerialContext';
import { useSerialContext } from './contexts/SerialContext';
import { ToastProvider, useToast } from './contexts/ToastContext';
import { FrameProvider } from './contexts/FrameContext';
import { SourceSelector } from './components/SourceSelector';
import { ProfileCard } from './components/ProfileCard';
import { ProfileModal } from './components/ProfileModal';
import { SessionsCard } from './components/SessionsCard';
import { FrameViewer } from './components/FrameViewer';
import { StatisticsCard } from './components/StatisticsCard';
import { DeviceMenuButton } from './components/DeviceMenuButton';
import { DeviceView } from './components/DeviceView';
import { useTheme } from './hooks/useTheme';
import type { PortInfo } from './hooks/useBackend';
import { parseJsonl } from './utils/journal';
import { describeConnectError, type Platform } from './utils/connectError';
import './App.css';

function AppContent() {
  const { theme, toggleTheme } = useTheme();
  const { connected, currentPort, profile, viewProfile, view, loading, dataSource, connect, disconnect, setProfile, loadFile, closeView, setOnDisconnected } = useSerialContext();
  const { addToast } = useToast();

  const [configModalOpen, setConfigModalOpen] = useState(false);
  const closeConfigModal = useCallback(() => setConfigModalOpen(false), []);
  const [connecting, setConnecting] = useState(false);
  // permission_denied advice differs per OS.
  const [platform, setPlatform] = useState<Platform>('other');
  useEffect(() => {
    invoke<string>('get_platform')
      .then((p) => setPlatform(p as Platform))
      .catch(() => { /* stays 'other' */ });
  }, []);
  const [appVersion, setAppVersion] = useState<string>('');
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => { /* ignore */ });
  }, []);
  // 'monitor': sidebar + frames; 'device': firmware update + diagnostics.
  const [currentView, setCurrentView] = useState<'monitor' | 'device'>('monitor');
  useEffect(() => {
    if (!connected && currentView === 'device') setCurrentView('monitor');
  }, [connected, currentView]);
  const [replayFilename, setReplayFilename] = useState<string | null>(null);
  const [currentPortInfo, setCurrentPortInfo] = useState<PortInfo | null>(null);
  const connectingPortRef = useRef<string | null>(null);

  useEffect(() => {
    setOnDisconnected(() => {
      setCurrentPortInfo(null);
      setCurrentView('monitor');
      addToast('warning', 'Device disconnected', 'Frames kept');
    });
    return () => setOnDisconnected(null);
  }, [setOnDisconnected, addToast]);

  const handleConnect = useCallback(async (port: string) => {
    if (connected) {
      try { await disconnect(); } catch { /* ignore */ }
    }
    if (dataSource === 'replay') {
      closeView();
      setReplayFilename(null);
    }

    setConnecting(true);
    connectingPortRef.current = port;
    try {
      await connect(port);
      setCurrentPortInfo(null); // Will be populated by port detection if available
      addToast('success', 'Connected', `Link-LR on ${port}`);
    } catch (err) {
      const { title, detail } = describeConnectError(err, port, platform);
      addToast('error', title, detail);
    } finally {
      setConnecting(false);
      connectingPortRef.current = null;
    }
  }, [connected, dataSource, connect, disconnect, closeView, addToast, platform]);

  const handleLoadCapture = useCallback(async (file: File) => {
    if (connected) {
      try { await disconnect(); } catch { /* ignore */ }
    }

    const lines = parseJsonl(await file.text());
    if (lines.length === 0) {
      addToast('error', 'Invalid file', 'No Link-LR recording lines found');
      return;
    }
    loadFile(file.name, lines);
    setReplayFilename(file.name);
    setCurrentPortInfo(null);
    addToast('success', 'Recording opened', `${lines.length} line${lines.length !== 1 ? 's' : ''} — ${file.name}`);
  }, [connected, disconnect, loadFile, addToast]);

  // Keeps frames; closing a replay clears them.
  const handleDisconnect = useCallback(async () => {
    await disconnect();
    setCurrentPortInfo(null);
    setCurrentView('monitor');
    addToast('info', 'Disconnected', 'Device disconnected');
  }, [disconnect, addToast]);

  const handleCloseReplay = useCallback(() => {
    closeView();
    setReplayFilename(null);
  }, [closeView]);

  const themeToggle = (
    <button
      onClick={toggleTheme}
      className="w-8 h-8 flex items-center justify-center rounded-element text-brand/70 hover:text-brand hover:bg-brand/10 transition-colors duration-200"
      title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
    >
      {theme === 'dark' ? (
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
          <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
          <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
        </svg>
      )}
    </button>
  );

  return (
    <div className="flex flex-col h-screen">
      {/* Toolbar */}
      <div className="h-16 bg-brand-dark flex items-center gap-2 px-4 border-b border-brand/10 relative">
        <SourceSelector
          dataSource={dataSource}
          currentPort={connecting ? connectingPortRef.current : currentPort}
          currentPortInfo={currentPortInfo}
          connected={connected}
          connecting={connecting || loading}
          replayFilename={replayFilename}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          onLoadFile={handleLoadCapture}
          onCloseReplay={handleCloseReplay}
        />

        {connected && (
          <DeviceMenuButton
            onClick={() => setCurrentView(currentView === 'device' ? 'monitor' : 'device')}
            active={currentView === 'device'}
          />
        )}

        {/* Absolutely centered, independent of left/right content */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5 text-brand mr-2">
            <path d="M2 12 L6 8 L10 16 L14 4 L18 14 L22 10" />
          </svg>
          <span className="text-brand font-semibold text-sm">Link Studio</span>
          {appVersion && (
            <span className="ml-2 text-[11px] text-brand/40 font-mono">v{appVersion}</span>
          )}
        </div>

        <div className="flex-1" />

        {themeToggle}
      </div>

      {/* Main */}
      <div className="flex flex-1 overflow-hidden">
        {currentView === 'monitor' ? (
          <>
            {/* Sidebar */}
            <div className="w-[280px] bg-base border-r border-brand/8 overflow-y-auto p-4 space-y-4">
              <ProfileCard
                profile={viewProfile}
                canModify={connected && view?.kind === 'live'}
                onEdit={() => setConfigModalOpen(true)}
              />
              <SessionsCard />
              <StatisticsCard />
            </div>

            {/* Content */}
            <div className="flex-1 overflow-hidden p-4">
              <FrameViewer />
            </div>
          </>
        ) : (
          <DeviceView onClose={() => setCurrentView('monitor')} />
        )}
      </div>

      {profile && (
        <ProfileModal
          open={configModalOpen}
          onClose={closeConfigModal}
          profile={profile}
          setProfile={setProfile}
        />
      )}
    </div>
  );
}

function App() {
  return (
    <SerialProvider>
      <ToastProvider>
        <FrameProvider>
          <AppContent />
        </FrameProvider>
      </ToastProvider>
    </SerialProvider>
  );
}

export default App;
