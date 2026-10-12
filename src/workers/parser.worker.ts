import type { WorkerRequest, WorkerResponse } from '../types/parser';

let parser: { name: string; version?: string; description?: string; decode: Function; analyze?: Function } | null = null;

function respond(msg: WorkerResponse) {
  self.postMessage(msg);
}

function loadParser(code: string) {
  try {
    const obj = new Function('return (' + code + ')')();

    if (!obj || typeof obj.name !== 'string') {
      respond({ type: 'load-error', error: 'Parser must export an object with a "name" property (string)' });
      return;
    }
    if (typeof obj.decode !== 'function') {
      respond({ type: 'load-error', error: 'Parser must export a "decode" function' });
      return;
    }

    const testResult = obj.decode('00', { timestamp: 0 });
    if (!testResult || !Array.isArray(testResult.fields)) {
      respond({ type: 'load-error', error: 'decode() must return an object with "fields" (array)' });
      return;
    }

    if (obj.analyze !== undefined && typeof obj.analyze !== 'function') {
      respond({ type: 'load-error', error: '"analyze" must be a function when present' });
      return;
    }

    parser = obj;
    respond({
      type: 'loaded',
      name: obj.name,
      version: obj.version,
      description: obj.description,
      hasAnalyze: typeof obj.analyze === 'function',
    });
  } catch (err) {
    respond({ type: 'load-error', error: `Load error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function decodeFrame(id: string, hex: string, context: { timestamp: number; rssi?: number; snr?: number }) {
  if (!parser) {
    respond({ type: 'decode-error', id, error: 'No parser loaded' });
    return;
  }

  try {
    const result = parser.decode(hex, context);
    if (!result || !Array.isArray(result.fields)) {
      respond({ type: 'decode-error', id, error: 'decode() returned an invalid result' });
      return;
    }
    respond({ type: 'decoded', id, result });
  } catch (err) {
    respond({ type: 'decode-error', id, error: `Decode error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function analyzeFrames(frames: Array<{ id: string; hex: string; timestamp: number; decoded: any }>) {
  if (!parser || typeof parser.analyze !== 'function') {
    respond({ type: 'analyze-error', error: 'Parser does not support analyze()' });
    return;
  }

  try {
    const result = parser.analyze(frames);
    if (!result || typeof result.annotations !== 'object' || !Array.isArray(result.metrics)) {
      respond({ type: 'analyze-error', error: 'analyze() must return { annotations, metrics }' });
      return;
    }
    respond({ type: 'analyzed', result });
  } catch (err) {
    respond({ type: 'analyze-error', error: `Analyze error: ${err instanceof Error ? err.message : String(err)}` });
  }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'load':
      loadParser(msg.code);
      break;
    case 'decode':
      decodeFrame(msg.id, msg.hex, msg.context);
      break;
    case 'analyze':
      analyzeFrames(msg.frames);
      break;
  }
};
