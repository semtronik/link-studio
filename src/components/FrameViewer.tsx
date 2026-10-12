import { useState, useEffect, useCallback } from 'react';
import { useSerialContext } from '../contexts/SerialContext';
import { useFrameContext } from '../contexts/FrameContext';
import { useParser } from '../hooks/useParser';
import { FrameTable } from './FrameTable';
import { FrameTimeline } from './FrameTimeline';
import { DetailPanel } from './DetailPanel';
import { ParserSelector } from './ParserSelector';
import { MetricsBanner } from './MetricsBanner';
import type { FrameData } from '../hooks/useBackend';
import type { DecodedFrame } from '../types/parser';
import type { CaptureFile } from '../types/capture';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';

export function FrameViewer() {
  const { connected, config, onFrame } = useSerialContext();
  const { frames, paused, annotations, metrics, addFrame, replaceFrames, clearFrames, setPaused, setAnnotations, setMetrics } = useFrameContext();
  const { parserInfo, parserError, decodeFrame, analyzeFrames, importParser, loadRawParser } = useParser();
  const [selectedFrame, setSelectedFrame] = useState<DecodedFrame | null>(null);

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

  const decodeAndAdd = useCallback(async (frame: FrameData) => {
    const timestamp = frame.timestamp;

    const decodedFrame: DecodedFrame = {
      id: frame.id,
      type: frame.type as 'frame',
      hex: frame.hex,
      timestamp,
      rssi: frame.rssi ?? undefined,
      snr: frame.snr ?? undefined,
    };

    try {
      const result = await decodeFrame(frame.id, frame.hex, {
        timestamp,
        rssi: frame.rssi ?? undefined,
        snr: frame.snr ?? undefined,
      });
      decodedFrame.decoded = result;
    } catch (err) {
      decodedFrame.decodeError = err instanceof Error ? err.message : String(err);
    }

    addFrame(decodedFrame);
  }, [decodeFrame, addFrame]);

  useEffect(() => {
    if (!connected || paused) return;

    const unlisten = onFrame((frame) => {
      decodeAndAdd(frame);
    });

    return () => {
      unlisten?.();
    };
  }, [connected, paused, onFrame, decodeAndAdd]);

  // Re-decode all frames when parser changes
  useEffect(() => {
    if (!parserInfo) return;

    if (!parserInfo.hasAnalyze) {
      setAnnotations({});
      setMetrics([]);
    }

    if (frames.length === 0) return;

    const redecode = async () => {
      const updated = await Promise.all(
        frames.map(async (frame) => {
          const decodedFrame: DecodedFrame = { ...frame, decoded: undefined, decodeError: undefined };
          try {
            const result = await decodeFrame(frame.id, frame.hex, {
              timestamp: frame.timestamp,
              rssi: frame.rssi,
              snr: frame.snr,
            });
            decodedFrame.decoded = result;
          } catch (err) {
            decodedFrame.decodeError = err instanceof Error ? err.message : String(err);
          }
          return decodedFrame;
        })
      );
      replaceFrames(updated);
    };

    redecode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parserInfo, decodeFrame]);

  const handleClear = () => {
    clearFrames();
    setSelectedFrame(null);
  };

  const handleExport = async () => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const defaultName = `capture_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;

    const filePath = await save({
      defaultPath: defaultName,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!filePath) return;

    const capture: CaptureFile = {
      // Without config, a reloaded capture cannot recompute time on air.
      config: config ?? undefined,
      frames: frames.map(f => ({
        timestamp: f.timestamp,
        rssi: f.rssi,
        snr: f.snr,
        hex: f.hex,
      })),
    };
    await writeTextFile(filePath, JSON.stringify(capture, null, 2));
  };

  return (
    <div className="flex flex-col h-full gap-4">
      {/* `flex-wrap` + `whitespace-nowrap`: wrap whole blocks rather than squeeze labels. */}
      <div className="flex flex-wrap justify-between items-center gap-y-2 gap-x-4 flex-shrink-0">
        <h2 className="text-[13px] font-medium text-text-secondary uppercase tracking-wider whitespace-nowrap">
          Captured frames <span className="text-brand font-mono">({frames.length})</span>
        </h2>

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
            className="px-3 py-1 rounded-element text-sm font-medium whitespace-nowrap transition-all duration-200 bg-overlay text-text-secondary hover:bg-brand/10 hover:text-brand disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Export
          </button>

          <button
            onClick={() => setPaused(!paused)}
            className={`px-3 py-1 rounded-element text-sm font-medium whitespace-nowrap transition-all duration-200 ${
              paused ? 'bg-rssi-good/20 text-rssi-good' : 'bg-overlay text-text-secondary'
            }`}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>

          <button
            onClick={handleClear}
            className="px-3 py-1 bg-rssi-bad/10 text-rssi-bad rounded-element text-sm font-medium whitespace-nowrap hover:bg-rssi-bad/20 transition-all duration-200"
          >
            Clear
          </button>
        </div>
      </div>

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
              sf={config?.sf}
              bw={config?.bw}
            />
          </div>

          <DetailPanel
            frame={selectedFrame}
            annotation={selectedFrame ? annotations[selectedFrame.id] : undefined}
            sf={config?.sf}
            bw={config?.bw}
          />
        </div>
      </div>
    </div>
  );
}
