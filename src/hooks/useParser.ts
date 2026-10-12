import { useState, useCallback, useRef, useEffect } from 'react';
import type { ParserInfo, DecodeResult, DecodeContext, AnalyzeResult, WorkerResponse } from '../types/parser';
import { RAW_PARSER_CODE } from '../parsers/raw';

export function useParser() {
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef<Map<string, { resolve: (r: DecodeResult) => void; reject: (e: Error) => void }>>(new Map());
  const loadPromiseRef = useRef<{ resolve: (info: ParserInfo) => void; reject: (e: Error) => void } | null>(null);
  const analyzePromiseRef = useRef<{ resolve: (r: AnalyzeResult) => void; reject: (e: Error) => void } | null>(null);

  const [parserInfo, setParserInfo] = useState<ParserInfo | null>(null);
  const [parserError, setParserError] = useState<string | null>(null);

  useEffect(() => {
    const worker = new Worker(
      new URL('../workers/parser.worker.ts', import.meta.url),
      { type: 'module' }
    );

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'loaded': {
          const info: ParserInfo = {
            name: msg.name,
            version: msg.version,
            description: msg.description,
            hasAnalyze: msg.hasAnalyze,
          };
          setParserInfo(info);
          setParserError(null);
          loadPromiseRef.current?.resolve(info);
          loadPromiseRef.current = null;
          break;
        }
        case 'load-error':
          setParserError(msg.error);
          loadPromiseRef.current?.reject(new Error(msg.error));
          loadPromiseRef.current = null;
          break;
        case 'decoded': {
          const pending = pendingRef.current.get(msg.id);
          if (pending) {
            pending.resolve(msg.result);
            pendingRef.current.delete(msg.id);
          }
          break;
        }
        case 'decode-error': {
          const pending = pendingRef.current.get(msg.id);
          if (pending) {
            pending.reject(new Error(msg.error));
            pendingRef.current.delete(msg.id);
          }
          break;
        }
        case 'analyzed':
          analyzePromiseRef.current?.resolve(msg.result);
          analyzePromiseRef.current = null;
          break;
        case 'analyze-error':
          analyzePromiseRef.current?.reject(new Error(msg.error));
          analyzePromiseRef.current = null;
          break;
      }
    };

    workerRef.current = worker;

    worker.postMessage({ type: 'load', code: RAW_PARSER_CODE });

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const loadParser = useCallback((code: string): Promise<ParserInfo> => {
    return new Promise((resolve, reject) => {
      if (!workerRef.current) {
        reject(new Error('Worker not initialized'));
        return;
      }
      loadPromiseRef.current = { resolve, reject };
      workerRef.current.postMessage({ type: 'load', code });
    });
  }, []);

  const loadRawParser = useCallback(() => {
    return loadParser(RAW_PARSER_CODE);
  }, [loadParser]);

  const decodeFrame = useCallback((id: string, hex: string, context: DecodeContext): Promise<DecodeResult> => {
    return new Promise((resolve, reject) => {
      if (!workerRef.current) {
        reject(new Error('Worker not initialized'));
        return;
      }
      pendingRef.current.set(id, { resolve, reject });
      workerRef.current.postMessage({ type: 'decode', id, hex, context });
    });
  }, []);

  const analyzeFrames = useCallback((frames: Array<{ id: string; hex: string; timestamp: number; decoded: DecodeResult }>): Promise<AnalyzeResult> => {
    return new Promise((resolve, reject) => {
      if (!workerRef.current) {
        reject(new Error('Worker not initialized'));
        return;
      }
      analyzePromiseRef.current = { resolve, reject };
      workerRef.current.postMessage({ type: 'analyze', frames });
    });
  }, []);

  const importParser = useCallback((): Promise<ParserInfo | null> => {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.js';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        try {
          const code = await file.text();
          const info = await loadParser(code);
          resolve(info);
        } catch (err) {
          resolve(null);
        }
      };
      input.click();
    });
  }, [loadParser]);

  return {
    parserInfo,
    parserError,
    loadParser,
    loadRawParser,
    decodeFrame,
    analyzeFrames,
    importParser,
  };
}
