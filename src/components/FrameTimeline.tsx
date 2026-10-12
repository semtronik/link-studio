import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import type { DecodedFrame } from '../types/parser';
import { marginClass } from '../utils/journal';

interface FrameTimelineProps {
  frames: DecodedFrame[];
  selectedFrameId: string | null;
  onSelectFrame: (frame: DecodedFrame) => void;
}

/* Zoomed out, a ToA of a few tens of ms falls below one pixel. */
const MIN_FRAME_PX = 2;

const CURSOR_GRAB_PX = 7;

/* A dragged cursor snaps to the nearest frame edge within this distance. */
const SNAP_PX = 8;

/* Bar height encodes payload size. */
const BAR_MIN_RATIO = 0.15;
const BAR_MAX_RATIO = 1;
const BAR_FULL_SCALE_BYTES = 255;

const TIMELINE_HEIGHT_KEY = 'link-studio.timeline.height';
const HEIGHT_MIN = 100;
const HEIGHT_DEFAULT = 140;
/* Must match FrameTable's `min-h`, or the table collapses. */
const TABLE_MIN_HEIGHT = 120;

function loadStoredHeight(): number {
  const raw = localStorage.getItem(TIMELINE_HEIGHT_KEY);
  const parsed = raw != null ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? Math.max(HEIGHT_MIN, parsed) : HEIGHT_DEFAULT;
}

/* Frames are placed by timestamp, not by rank, so bursts and gaps stay visible. */

/* The device's palette (link_theme.c): margin classes, brand blue for our own frames. */
const COLOR_GOOD = '#4ADE80';
const COLOR_MEDIUM = '#FBBF24';
const COLOR_BAD = '#F87171';
const COLOR_UNKNOWN = '#64748B';
const COLOR_TX = '#47ABFF';

function marginColor(margin?: number): string {
  if (margin == null) return COLOR_UNKNOWN;
  const cls = marginClass(margin);
  return cls === 'good' ? COLOR_GOOD : cls === 'fair' ? COLOR_MEDIUM : COLOR_BAD;
}

const AXIS_HEIGHT = 28;
const AXIS_FONT_PX = 14;
const TICK_HIT_RADIUS = 6;
const MIN_SPAN_MS = 20;
const PADDING_RATIO = 0.02;

const NICE_STEPS_MS = [
  10, 20, 50, 100, 200, 500,
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000,
  60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
  3_600_000, 7_200_000, 21_600_000, 43_200_000, 86_400_000,
];

function niceStep(rawMs: number): number {
  return NICE_STEPS_MS.find(s => s >= rawMs) ?? NICE_STEPS_MS[NICE_STEPS_MS.length - 1];
}

function formatAxisLabel(ms: number, stepMs: number): string {
  const d = new Date(ms);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  /* Below one second, hh:mm:ss alone no longer tells ticks apart. */
  return stepMs < 1000 ? `${hms}.${pad(d.getMilliseconds(), 3)}` : hms;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function FrameTimeline({ frames, selectedFrameId, onSelectFrame }: FrameTimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  /* null = auto-follow the whole capture; set once the user zooms or pans. */
  const [view, setView] = useState<{ start: number; end: number } | null>(null);
  const dragRef = useRef<{ x: number; start: number; end: number; moved: boolean } | null>(null);

  const [cursors, setCursors] = useState<{ a: number; b: number } | null>(null);
  const cursorDragRef = useRef<'a' | 'b' | null>(null);
  const [overCursor, setOverCursor] = useState(false);

  const [height, setHeight] = useState(loadStoredHeight);
  const resizeRef = useRef<{ y: number; height: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const maxHeightRef = useRef(Number.POSITIVE_INFINITY);

  useEffect(() => {
    localStorage.setItem(TIMELINE_HEIGHT_KEY, String(height));
  }, [height]);


  /* The stored height may exceed the space left in a smaller window. */
  useEffect(() => {
    const clamp = () => {
      const column = rootRef.current?.parentElement;
      if (!column) return;
      const max = Math.max(HEIGHT_MIN, column.clientHeight - TABLE_MIN_HEIGHT);
      setHeight(h => Math.min(h, max));
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, []);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      /* Cap on the column shared by table + timeline, not the whole window. */
      const column = rootRef.current?.parentElement;
      const available = column?.clientHeight ?? window.innerHeight;
      maxHeightRef.current = Math.max(HEIGHT_MIN, available - TABLE_MIN_HEIGHT);
      resizeRef.current = { y: e.clientY, height };
    },
    [height]
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      const max = maxHeightRef.current;
      setHeight(Math.max(HEIGHT_MIN, Math.min(max, r.height - (e.clientY - r.y))));
    };
    const onUp = () => {
      if (!resizeRef.current) return;
      resizeRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  /* Frames with a time on air: received with a length, and our own transmissions. */
  const points = useMemo(() => {
    return frames
      .filter(frame => frame.toaMs != null)
      .map(frame => {
        const bytes = frame.hex.length / 2;
        const toaMs = frame.toaMs!;
        /* The timestamp marks the START of the frame: the bar extends right. */
        const tStart = frame.timestamp * 1000;
        return { frame, t: tStart + toaMs, tStart, bytes, toaMs };
      })
      .sort((a, b) => a.t - b.t);
  }, [frames]);

  const bounds = useMemo(() => {
    if (points.length === 0) return null;
    const first = points[0].tStart;
    const last = points[points.length - 1].t;
    /* A single frame or a very short burst would give a degenerate scale. */
    const span = Math.max(last - first, MIN_SPAN_MS);
    const pad = span * PADDING_RATIO;
    return { start: first - pad, end: last + pad };
  }, [points]);

  const activeView = view ?? bounds;

  /* Re-place cursors only on a new capture, not on every live frame. */
  const prevStart = useRef<number | null>(null);
  useEffect(() => {
    if (!bounds) {
      prevStart.current = null;
      return;
    }
    /* Live frames only extend the end, so a changed start means a new capture. */
    if (prevStart.current === null || Math.abs(bounds.start - prevStart.current) > 1) {
      const span = bounds.end - bounds.start;
      setCursors({ a: bounds.start + span * 0.25, b: bounds.start + span * 0.75 });
    }
    prevStart.current = bounds.start;
  }, [bounds]);

  const measure = useMemo(() => {
    if (!cursors) return null;
    const from = Math.min(cursors.a, cursors.b);
    const to = Math.max(cursors.a, cursors.b);
    return {
      from,
      to,
      deltaMs: to - from,
      count: points.filter(p => p.t >= from && p.t <= to).length,
    };
  }, [cursors, points]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      const r = entries[0].contentRect;
      setSize({ width: r.width, height: r.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /* External selection: recenter only if the frame is out of view. */
  useEffect(() => {
    if (!view || !selectedFrameId) return;
    const target = points.find(p => p.frame.id === selectedFrameId);
    if (!target) return;
    if (target.t >= view.start && target.t <= view.end) return;
    const span = view.end - view.start;
    setView({ start: target.t - span / 2, end: target.t + span / 2 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFrameId]);

  const toX = useCallback(
    (t: number) => {
      if (!activeView || size.width === 0) return 0;
      return ((t - activeView.start) / (activeView.end - activeView.start)) * size.width;
    },
    [activeView, size.width]
  );

  /* ---------- Rendering ---------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeView || size.width === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    /* setTransform, not scale: scale accumulates across renders. */
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);

    const plotH = size.height - AXIS_HEIGHT;
    const spanMs = activeView.end - activeView.start;

    const targetTicks = Math.max(2, Math.floor(size.width / 130));
    const step = niceStep(spanMs / targetTicks);
    const firstTick = Math.ceil(activeView.start / step) * step;

    ctx.font = `${AXIS_FONT_PX}px monospace`;
    ctx.textBaseline = 'top';
    for (let t = firstTick; t <= activeView.end; t += step) {
      const x = toX(t);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, plotH);
      ctx.stroke();

      ctx.fillStyle = 'rgba(148,163,184,0.75)';
      ctx.textAlign = 'center';
      ctx.fillText(formatAxisLabel(t, step), x, plotH + 4);
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.moveTo(0, Math.round(plotH) + 0.5);
    ctx.lineTo(size.width, Math.round(plotH) + 0.5);
    ctx.stroke();

    /* Width = time on air, height = payload size: on-screen overlap is real on-air overlap. */
    const baseline = plotH - 4;
    const usableH = baseline - 6;
    for (const p of points) {
      const x = toX(p.tStart);
      const w = Math.max(MIN_FRAME_PX, toX(p.t) - x);
      if (x + w < -2 || x > size.width + 2) continue;

      const ratio = Math.min(1, p.bytes / BAR_FULL_SCALE_BYTES);
      const h = usableH * (BAR_MIN_RATIO + ratio * (BAR_MAX_RATIO - BAR_MIN_RATIO));
      const isSelected = p.frame.id === selectedFrameId;

      ctx.fillStyle = isSelected ? '#47ABFF'
        : p.frame.kind === 'tx' ? COLOR_TX
        : p.frame.status === 'crc_err' ? COLOR_BAD
        : marginColor(p.frame.margin);
      ctx.globalAlpha = isSelected ? 1 : 0.75;
      ctx.fillRect(x, baseline - h, w, h);
      ctx.globalAlpha = 1;

      if (isSelected) {
        ctx.strokeStyle = '#47ABFF';
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(x) - 0.5, baseline - h - 1.5, Math.round(w) + 1, h + 2);
      }
    }

    if (measure) {
      const xa = toX(measure.from);
      const xb = toX(measure.to);
      ctx.fillStyle = 'rgba(71,171,255,0.10)';
      ctx.fillRect(xa, 0, xb - xa, plotH);
    }

    const drawCursor = (t: number, label: string) => {
      const x = Math.round(toX(t)) + 0.5;

      ctx.strokeStyle = '#47ABFF';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#47ABFF';
      ctx.fillRect(x - 8, 0, 16, 14);
      ctx.fillStyle = '#0B1220';
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(label, x, 2);
    };

    if (cursors) {
      drawCursor(cursors.a, 'A');
      drawCursor(cursors.b, 'B');
    }
  }, [points, activeView, size, selectedFrameId, toX, cursors, measure]);

  /* ---------- Interactions ---------- */

  const frameAt = useCallback(
    (clientX: number): DecodedFrame | null => {
      const canvas = canvasRef.current;
      if (!canvas || !activeView) return null;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      let best: DecodedFrame | null = null;
      let bestDist = TICK_HIT_RADIUS;
      for (const p of points) {
        const x0 = toX(p.tStart);
        const x1 = Math.max(x0 + MIN_FRAME_PX, toX(p.t));
        const d = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
        if (d <= bestDist) {
          bestDist = d;
          best = p.frame;
        }
      }
      return best;
    },
    [points, activeView, toX]
  );

  /* Native listener: React's onWheel is passive, so preventDefault would be ignored. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      if (!activeView || size.width === 0) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / size.width;
      const span = activeView.end - activeView.start;
      /* Zoom anchored on the mouse position. */
      const factor = e.deltaY > 0 ? 1.25 : 0.8;
      const newSpan = Math.max(MIN_SPAN_MS, span * factor);
      const anchor = activeView.start + span * ratio;
      setView({
        start: anchor - newSpan * ratio,
        end: anchor + newSpan * (1 - ratio),
      });
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [activeView, size.width]);

  const cursorAt = useCallback(
    (clientX: number): 'a' | 'b' | null => {
      const canvas = canvasRef.current;
      if (!canvas || !cursors) return null;
      const x = clientX - canvas.getBoundingClientRect().left;
      const da = Math.abs(toX(cursors.a) - x);
      const db = Math.abs(toX(cursors.b) - x);
      if (Math.min(da, db) > CURSOR_GRAB_PX) return null;
      return da <= db ? 'a' : 'b';
    },
    [cursors, toX]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!activeView) return;
      /* Grabbing a cursor takes priority over panning. */
      const grabbed = cursorAt(e.clientX);
      if (grabbed) {
        cursorDragRef.current = grabbed;
        return;
      }
      dragRef.current = {
        x: e.clientX,
        start: activeView.start,
        end: activeView.end,
        moved: false,
      };
    },
    [activeView, cursorAt]
  );

  /* Threshold in pixels so snapping feels the same at any zoom. */
  const snapTime = useCallback(
    (x: number): number => {
      if (!activeView || size.width === 0) return 0;
      const span = activeView.end - activeView.start;
      const t = activeView.start + (x / size.width) * span;
      let best = t;
      let bestPx = SNAP_PX;
      for (const p of points) {
        for (const edge of [p.tStart, p.t]) {
          const dpx = Math.abs(toX(edge) - x);
          if (dpx < bestPx) {
            bestPx = dpx;
            best = edge;
          }
        }
      }
      return best;
    },
    [activeView, size.width, points, toX]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const grabbed = cursorDragRef.current;
      if (grabbed && activeView && size.width > 0) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const x = e.clientX - canvas.getBoundingClientRect().left;
        setCursors(prev => (prev ? { ...prev, [grabbed]: snapTime(x) } : prev));
        return;
      }

      const drag = dragRef.current;
      if (drag && size.width > 0) {
        const dx = e.clientX - drag.x;
        if (Math.abs(dx) > 2) drag.moved = true;
        const span = drag.end - drag.start;
        const shift = (dx / size.width) * span;
        setView({ start: drag.start - shift, end: drag.end - shift });
        return;
      }
      setOverCursor(cursorAt(e.clientX) != null);
    },
    [cursorAt, snapTime, activeView, size.width]
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
    cursorDragRef.current = null;
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      /* A pan or cursor drag is not a selection. */
      if (dragRef.current?.moved || cursorDragRef.current) return;
      const frame = frameAt(e.clientX);
      if (frame) onSelectFrame(frame);
    },
    [frameAt, onSelectFrame]
  );

  const resetView = useCallback(() => setView(null), []);

  const centerCursors = useCallback(() => {
    if (!activeView) return;
    const span = activeView.end - activeView.start;
    setCursors({
      a: activeView.start + span * 0.25,
      b: activeView.start + span * 0.75,
    });
  }, [activeView]);

  const spanLabel = activeView ? formatDuration(activeView.end - activeView.start) : '';

  return (
    <div
      ref={rootRef}
      style={{ height }}
      className="flex-shrink-0 flex flex-col rounded-card bg-surface border border-[rgba(255,255,255,0.04)] shadow-subtle"
    >
      <div
        onMouseDown={startResize}
        className="group h-2 flex-shrink-0 cursor-row-resize flex items-center justify-center"
        title="Drag to resize"
      >
        <div className="w-10 h-[3px] rounded-full bg-border group-hover:bg-brand/50 transition-colors duration-200" />
      </div>

      {/* Fixed layout: items toggle enabled state but never appear/disappear, so the row never shifts. */}
      <div className="flex flex-shrink-0 items-center justify-between px-4 gap-4">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-[11px] font-medium text-text-secondary uppercase tracking-wider">
            Timeline
          </span>
          <span className="font-mono text-[11px] text-text-muted">{spanLabel || '—'}</span>
          <span className="font-mono text-[12px] text-brand whitespace-nowrap">
            {measure
              ? `Δ A→B ${formatDuration(measure.deltaMs)} · ${measure.count} frame${measure.count !== 1 ? 's' : ''}`
              : ''}
          </span>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={centerCursors}
            disabled={!cursors}
            className="px-2 py-0.5 bg-overlay text-text-secondary rounded-element text-[11px] font-medium whitespace-nowrap hover:bg-brand/10 hover:text-brand disabled:opacity-30 disabled:hover:bg-overlay disabled:hover:text-text-secondary transition-colors duration-200"
          >
            Center cursors
          </button>
          <button
            onClick={resetView}
            disabled={!view}
            className="px-2 py-0.5 bg-overlay text-text-secondary rounded-element text-[11px] font-medium whitespace-nowrap hover:bg-brand/10 hover:text-brand disabled:opacity-30 disabled:hover:bg-overlay disabled:hover:text-text-secondary transition-colors duration-200"
          >
            Fit all
          </button>
        </div>
      </div>

      <div ref={wrapRef} className="relative flex-1 min-h-0 mx-2 mb-2">
        {frames.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[12px] text-text-muted">No frames</span>
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            className={`absolute inset-0 w-full h-full ${
              cursorDragRef.current || overCursor
                ? 'cursor-ew-resize'
                : dragRef.current
                  ? 'cursor-grabbing'
                  : 'cursor-crosshair'
            }`}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={endDrag}
            onMouseLeave={() => {
              endDrag();
              setOverCursor(false);
            }}
            onClick={handleClick}
          />
        )}
      </div>
    </div>
  );
}
