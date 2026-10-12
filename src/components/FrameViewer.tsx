import { useState, useEffect, useCallback } from 'react';
import { useSerialContext } from '../contexts/SerialContext';
import { useFrameContext } from '../contexts/FrameContext';
import { useToast } from '../contexts/ToastContext';
import { useParser } from '../hooks/useParser';
import { FrameTable } from './FrameTable';
import { FrameTimeline } from './FrameTimeline';
import { DetailPanel } from './DetailPanel';
import { ParserSelector } from './ParserSelector';
import { MetricsBanner } from './MetricsBanner';
import { TransmitBar } from './TransmitBar';
import type { DecodedFrame } from '../types/parser';
import type { Frame } from '../types/journal';
import { isDecodable, lineToFrame, linesToFrames, toJsonl } from '../utils/journal';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';

const BUTTON = 'px-3 py-1 rounded-element text-sm font-medium whitespace-nowrap transition-all duration-200';

export function FrameViewer() {
  const { connected, profile, view, liveSessionId, onShow, onLine, showLive, newSession, transmit, getViewLines } = useSerialContext();
  const { frames, paused, annotations, metrics, addFrame, replaceFrames, setPaused, setAnnotations, setMetrics } = useFrameContext();
  const { addToast } = useToast();
  const { parserInfo, parserError, decodeFrame, analyzeFrames, importParser, loadRawParser } = useParser();
  const [selectedFrame, setSelectedFrame] = useState<DecodedFrame | null>(null);

  const isLive = view?.kind === 'live' && connected;

  // Run analyze when frames change (debounced)
  useEffect(() => {
    if (!parserInfo?.hasAnalyze || frames.length === 0) return;

    const timer = setTimeout(async () => {
      const analyzable = frames.filter(f => f.decoded).map(f => ({
        id: f.id,
        hex: f.hex,
        timestamp: f.timestamp,
        decoded: f.decoded!,
      }));
      if (analyzable.length === 0) return;

      try {
        const result = await analyzeFrames(analyzable);
        setAnnotations(result.annotations);
        setMetrics(result.metrics);
      } catch (err) {
        console.warn('[analyze]', err);
      }
    }, 500);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames, parserInfo?.hasAnalyze, analyzeFrames]);

  const decode = useCallback(async (frame: Frame): Promise<DecodedFrame> => {
    const decodedFrame: DecodedFrame = { ...frame };
    if (!isDecodable(frame)) return decodedFrame;
    try {
      decodedFrame.decoded = await decodeFrame(frame.id, frame.hex, {
        timestamp: frame.timestamp,
        rssi: frame.rssi,
        snr: frame.snr,
      });
    } catch (err) {
      decodedFrame.decodeError = err instanceof Error ? err.message : String(err);
    }
    return decodedFrame;
  }, [decodeFrame]);

  // Registered regardless of `connected`: the running session is read during connect.
  useEffect(() => {
    return onShow((lines) => {
      setSelectedFrame(null);
      setAnnotations({});
      setMetrics([]);
      Promise.all(linesToFrames(lines).map(decode)).then(replaceFrames);
    });
  }, [onShow, decode, replaceFrames, setAnnotations, setMetrics]);

  // Back from the Device view: catch up on lines that arrived while unmounted.
  useEffect(() => {
    if (connected && view?.kind === 'live' && !paused) showLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live lines belong to the running session, whose SF is the device's.
  const liveSf = profile?.sf;
  useEffect(() => {
    if (paused) return;
    return onLine((line) => {
      const frame = lineToFrame(line, liveSf);
      if (frame) decode(frame).then(addFrame);
    });
  }, [paused, onLine, decode, addFrame, liveSf]);

  // Re-decode all frames when parser changes
  useEffect(() => {
    if (!parserInfo) return;

    if (!parserInfo.hasAnalyze) {
      setAnnotations({});
      setMetrics([]);
    }

    if (frames.length === 0) return;

    Promise.all(frames.map(f => decode({ ...f, decoded: undefined, decodeError: undefined } as DecodedFrame)))
      .then(replaceFrames);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parserInfo, decodeFrame]);

  const togglePause = () => {
    // Resuming catches up on what arrived meanwhile.
    if (paused) showLive();
    setPaused(!paused);
  };

  const handleNewSession = async () => {
    try {
      await newSession();
    } catch (err) {
      addToast('error', 'New session failed', String(err));
    }
  };

  const handleTransmit = useCallback(async (hex: string) => {
    try {
      await transmit(hex);
      return true;
    } catch (err) {
      addToast('error', 'Transmission refused', String(err));
      return false;
    }
  }, [transmit, addToast]);

  const handleExport = async () => {
    const lines = getViewLines();
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const id = view?.kind === 'session' ? view.id : view?.kind === 'live' ? liveSessionId : null;
    const filePath = await save({
      defaultPath: id != null ? `link-lr_session-${id}_${stamp}.jsonl` : `link-lr_${stamp}.jsonl`,
      filters: [{ name: 'Link-LR recording', extensions: ['jsonl'] }],
    });
    if (!filePath) return;
    await writeTextFile(filePath, toJsonl(lines));
  };

  let title = 'Journal';
  if (view?.kind === 'live') title = liveSessionId != null ? `Session ${liveSessionId} · live` : 'Live';
  else if (view?.kind === 'session') title = `Session ${view.id}`;
  else if (view?.kind === 'file') title = view.name;

  return (
    <div className="flex flex-col h-full gap-4">
      {/* `flex-wrap` + `whitespace-nowrap`: wrap whole blocks rather than squeeze labels. */}
      <div className="flex flex-wrap justify-between items-center gap-y-2 gap-x-4 flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <h2 className="text-[13px] font-medium text-text-secondary uppercase tracking-wider whitespace-nowrap truncate">
            {title} <span className="text-brand font-mono">({frames.length})</span>
          </h2>
          {view?.kind === 'session' && connected && (
            <button
              onClick={() => { setPaused(false); showLive(); }}
              className={`${BUTTON} bg-brand/10 text-brand hover:bg-brand/20`}
            >
              Back to live
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <ParserSelector
            parserInfo={parserInfo}
            parserError={parserError}
            onImport={importParser}
            onReset={loadRawParser}
          />

          <button
            onClick={handleExport}
            disabled={frames.length === 0}
            className={`${BUTTON} bg-overlay text-text-secondary hover:bg-brand/10 hover:text-brand disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            Export
          </button>

          {isLive && (
            <>
              <button
                onClick={togglePause}
                className={`${BUTTON} ${paused ? 'bg-rssi-good/20 text-rssi-good' : 'bg-overlay text-text-secondary'}`}
              >
                {paused ? 'Resume' : 'Pause'}
              </button>

              <button
                onClick={handleNewSession}
                title="Closes the running session on the device and starts a new one"
                className={`${BUTTON} bg-rssi-bad/10 text-rssi-bad hover:bg-rssi-bad/20`}
              >
                New session
              </button>
            </>
          )}
        </div>
      </div>

      {isLive && <TransmitBar onTransmit={handleTransmit} />}

      {metrics.length > 0 && <MetricsBanner metrics={metrics} />}

      {/* A container query cannot target the container itself, hence the inner div. */}
      <div className="@container flex-1 min-h-0">
        <div className="h-full flex flex-col @[1140px]:flex-row gap-4 min-h-0">
          <div className="flex-1 flex flex-col gap-4 h-full min-h-0 min-w-0 overflow-hidden">
            <FrameTable
              frames={frames}
              annotations={annotations}
              selectedFrameId={selectedFrame?.id ?? null}
              onSelectFrame={setSelectedFrame}
            />

            <FrameTimeline
              frames={frames}
              selectedFrameId={selectedFrame?.id ?? null}
              onSelectFrame={setSelectedFrame}
            />
          </div>

          <DetailPanel
            frame={selectedFrame}
            annotation={selectedFrame ? annotations[selectedFrame.id] : undefined}
            onReplay={isLive ? handleTransmit : undefined}
          />
        </div>
      </div>
    </div>
  );
}
