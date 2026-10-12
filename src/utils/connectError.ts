import type { DeviceKind } from '../hooks/useBackend';

/**
 * Error returned by `serial_connect`, mirroring the Rust `ConnectError`
 * (serde, tag = "code"). The backend sends a code, the port and the raw OS
 * message; wording lives here.
 */
export type ConnectErrorCode =
  | 'port_busy'
  | 'port_not_found'
  | 'permission_denied'
  | 'invalid_settings'
  | 'other'
  | 'unsupported_device';

export interface ConnectError {
  code: ConnectErrorCode;
  port: string;
  raw: string;
  kind?: DeviceKind;
}

export function isConnectError(err: unknown): err is ConnectError {
  if (typeof err !== 'object' || err === null) return false;
  const obj = err as Record<string, unknown>;
  return (
    typeof obj.code === 'string' &&
    typeof obj.port === 'string' &&
    typeof obj.raw === 'string'
  );
}

export type Platform = 'windows' | 'macos' | 'linux' | 'other';

function buildMessages(_platform: Platform): Record<ConnectErrorCode, (e: ConnectError) => { title: string; detail: string }> {
  return {
    port_busy: (e) => ({
      title: 'Port busy',
      detail: `${e.port} is already in use by another application.`,
    }),
    port_not_found: (e) => ({
      title: 'Port not found',
      detail: `${e.port} is no longer available.`,
    }),
    permission_denied: (e) => ({
      title: 'Permission denied',
      detail: `Access to ${e.port} was refused.`,
    }),
    invalid_settings: (e) => ({
      title: 'Invalid serial settings',
      detail: `The connection settings were refused on ${e.port}.`,
    }),
    other: (e) => ({
      title: 'Connection failed',
      detail: `Could not connect to ${e.port}.`,
    }),
    unsupported_device: (e) => e.kind === 'lft'
      ? {
          title: 'LFT prototype',
          detail: 'Link Studio drives Link devices only. Use lft-app 1.0.1 for the LFT prototype.',
        }
      : {
          title: 'Unsupported device',
          detail: `The device on ${e.port} is not a Link-LR (${e.raw}).`,
        },
  };
}

export function formatConnectError(err: ConnectError, platform: Platform = 'other'): { title: string; detail: string } {
  return buildMessages(platform)[err.code](err);
}

/** Any error caught from `serial_connect`, structured or not. */
export function describeConnectError(err: unknown, port: string, platform: Platform = 'other'): { title: string; detail: string } {
  if (isConnectError(err)) {
    return formatConnectError(err, platform);
  }
  const raw = typeof err === 'string'
    ? err
    : (err instanceof Error ? err.message : String(err));
  return {
    title: 'Connection failed',
    detail: `Could not connect to ${port}. Details: ${raw}`,
  };
}
