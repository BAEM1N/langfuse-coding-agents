import { createHash } from 'node:crypto';
import type { Config } from './config.ts';
import type { OtlpConfig } from './otlp.ts';

export const LANGFUSE_OTLP_PATH = '/api/public/otel/v1/traces';

export interface Destination {
  /** Stable identifier without credentials; used as the delivery-state key. */
  id: string;
  kind: 'langfuse-legacy' | 'langfuse-otlp' | 'otlp';
  label: string;
  /**
   * True when the receiver upserts by ID, so a whole turn may be sent again.
   * Langfuse v4 and generic OTLP receivers do not deduplicate span IDs.
   */
  idempotent: boolean;
  /** Receivers that cannot update a span only get turns that have ended. */
  completedOnly: boolean;
  /** A 2xx from a relay means it accepted the request, not that a backend stored it. */
  relay: boolean;
  otlp?: OtlpConfig;
  configError?: string;
}

const short = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 8);

/** Host and path only: no user info, query string, or fragment. */
export function endpointIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host + parsed.pathname.replace(/\/+$/, '');
  } catch {
    return 'invalid';
  }
}

function pointsAtLangfuse(config: Config): boolean {
  if (config.otlpForwardsToLangfuse) return true;
  if (!config.otlp) return false;
  try {
    const endpoint = new URL(config.otlp.endpoint);
    return endpoint.host === new URL(config.baseUrl).host && endpoint.pathname.includes('/api/public/otel');
  } catch {
    return false;
  }
}

export function langfuseOtlpConfig(config: Config): OtlpConfig {
  // These headers exist only on this destination. The generic OTLP destination
  // is built from OTEL_EXPORTER_* settings and never sees the project keys.
  const headers = new Headers({
    'Content-Type': 'application/json',
    Authorization: 'Basic ' + Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64'),
    'x-langfuse-ingestion-version': '4',
  });
  return { endpoint: config.baseUrl + LANGFUSE_OTLP_PATH, headers, captureContent: config.langfuseCaptureContent,
    timeoutMs: config.timeoutMs };
}

export function resolveDestinations(config: Config): Destination[] {
  const out: Destination[] = [];
  if (config.otlpError) {
    out.push({ id: 'otlp:invalid', kind: 'otlp', label: 'OTLP receiver', idempotent: false, completedOnly: true,
      relay: true, configError: config.otlpError });
  }
  if (config.otlp) {
    out.push({ id: 'otlp:' + endpointIdentity(config.otlp.endpoint), kind: 'otlp', label: 'OTLP receiver',
      idempotent: false, completedOnly: true, relay: true, otlp: config.otlp });
  }
  if (config.enabled && config.publicKey && config.secretKey) {
    const project = '#' + short(config.publicKey);
    const otlp = config.langfuseTransport === 'otlp';
    const destination: Destination = otlp
      ? { id: 'langfuse-otlp:' + endpointIdentity(config.baseUrl + LANGFUSE_OTLP_PATH) + project, kind: 'langfuse-otlp',
        label: 'Langfuse (OTLP)', idempotent: false, completedOnly: true, relay: false, otlp: langfuseOtlpConfig(config) }
      : { id: 'langfuse-legacy:' + endpointIdentity(config.baseUrl + '/api/public/ingestion') + project,
        kind: 'langfuse-legacy', label: 'Langfuse (legacy ingestion)', idempotent: true, completedOnly: false, relay: false };
    if (config.transportError) destination.configError = config.transportError;
    else if (pointsAtLangfuse(config) && !config.allowDualLangfuse) {
      destination.configError = 'The OTLP receiver already forwards to Langfuse; direct Langfuse export is disabled to avoid ' +
        'duplicate traces. Set TRACE_TO_LANGFUSE=false, or LANGFUSE_HOOK_ALLOW_DUAL_ROUTE=true to send both.';
    }
    out.push(destination);
  }
  return out;
}

/** Legacy trace ingestion on a Langfuse Cloud host was retired on 2026-11-16. */
export function isLangfuseCloud(baseUrl: string): boolean {
  try { return /(^|\.)cloud\.langfuse\.com$/.test(new URL(baseUrl).hostname); } catch { return false; }
}
