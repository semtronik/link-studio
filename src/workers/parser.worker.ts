import type { WorkerRequest, WorkerResponse } from '../types/parser';

let parser: { name: string; version?: string; description?: string; decode: Function; analyze?: Function } | null = null;

function respond(msg: WorkerResponse) {
  self.postMessage(msg);
}

function loadParser(code: string) {
  try {
    const obj = new Function('return (' + code + ')')();

    if (!obj || typeof obj.name !== 'string') {
      respond({ type: 'load-error', error: 'Le parseur doit exporter un objet avec une propriété "name" (string)' });
      return;
    }
    if (typeof obj.decode !== 'function') {
      respond({ type: 'load-error', error: 'Le parseur doit exporter une fonction "decode"' });
      return;
    }

    // Test de validation : decode avec un hex de test
    const testResult = obj.decode('00', { timestamp: 0 });
    if (!testResult || !Array.isArray(testResult.fields)) {
      respond({ type: 'load-error', error: 'decode() doit retourner un objet avec "fields" (array)' });
      return;
    }

    if (obj.analyze !== undefined && typeof obj.analyze !== 'function') {
      respond({ type: 'load-error', error: '"analyze" doit être une fonction si présent' });
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
    respond({ type: 'load-error', error: `Erreur de chargement : ${err instanceof Error ? err.message : String(err)}` });
  }
}

function decodeFrame(id: string, hex: string, context: { timestamp: number; rssi?: number; snr?: number }) {
  if (!parser) {
    respond({ type: 'decode-error', id, error: 'Aucun parseur chargé' });
    return;
  }

  try {
    const result = parser.decode(hex, context);
    if (!result || !Array.isArray(result.fields)) {
      respond({ type: 'decode-error', id, error: 'decode() a retourné un résultat invalide' });
      return;
    }
    respond({ type: 'decoded', id, result });
  } catch (err) {
    respond({ type: 'decode-error', id, error: `Erreur decode : ${err instanceof Error ? err.message : String(err)}` });
  }
}

function analyzeFrames(frames: Array<{ id: string; hex: string; timestamp: number; decoded: any }>) {
  if (!parser || typeof parser.analyze !== 'function') {
    respond({ type: 'analyze-error', error: 'Le parseur ne supporte pas analyze()' });
    return;
  }

  try {
    const result = parser.analyze(frames);
    if (!result || typeof result.annotations !== 'object' || !Array.isArray(result.metrics)) {
      respond({ type: 'analyze-error', error: 'analyze() doit retourner { annotations, metrics }' });
      return;
    }
    respond({ type: 'analyzed', result });
  } catch (err) {
    respond({ type: 'analyze-error', error: `Erreur analyze : ${err instanceof Error ? err.message : String(err)}` });
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
