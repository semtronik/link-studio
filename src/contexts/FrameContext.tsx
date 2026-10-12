import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DecodedFrame, Annotation, Metric } from '../types/parser';

interface FrameContextType {
  frames: DecodedFrame[];
  paused: boolean;
  annotations: Record<string, Annotation>;
  metrics: Metric[];
  addFrame: (frame: DecodedFrame) => void;
  replaceFrames: (frames: DecodedFrame[]) => void;
  clearFrames: () => void;
  setPaused: (paused: boolean) => void;
  setAnnotations: (annotations: Record<string, Annotation>) => void;
  setMetrics: (metrics: Metric[]) => void;
}

const FrameContext = createContext<FrameContextType | null>(null);

export function FrameProvider({ children }: { children: ReactNode }) {
  const [frames, setFrames] = useState<DecodedFrame[]>([]);
  const [paused, setPaused] = useState(false);
  const [annotations, setAnnotations] = useState<Record<string, Annotation>>({});
  const [metrics, setMetrics] = useState<Metric[]>([]);

  const addFrame = useCallback((frame: DecodedFrame) => {
    setFrames(prev => [...prev, frame].slice(-500));
  }, []);

  const replaceFrames = useCallback((newFrames: DecodedFrame[]) => {
    setFrames(newFrames);
  }, []);

  const clearFrames = useCallback(() => {
    setFrames([]);
    setAnnotations({});
    setMetrics([]);
    invoke('clear_frames').catch(() => {});
  }, []);

  return (
    <FrameContext.Provider value={{ frames, paused, annotations, metrics, addFrame, replaceFrames, clearFrames, setPaused, setAnnotations, setMetrics }}>
      {children}
    </FrameContext.Provider>
  );
}

export function useFrameContext(): FrameContextType {
  const ctx = useContext(FrameContext);
  if (!ctx) {
    throw new Error('useFrameContext must be used within a FrameProvider');
  }
  return ctx;
}
