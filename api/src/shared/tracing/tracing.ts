import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { trace } from '@opentelemetry/api';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

let sdk: NodeSDK | null = null;

/**
 * Initializes OpenTelemetry NodeSDK tracing if configured and enabled
 */
export function initializeTracing(): void {
  if (!env.OTEL_ENABLED) {
    logger.info('OpenTelemetry tracing is disabled (OTEL_ENABLED=false)');
    return;
  }

  const exporter = new OTLPTraceExporter({
    url: env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
  });

  sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME || 'truthshield-api',
    traceExporter: exporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Turn off fs and net instrumentation to minimize noise/overhead
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
  });

  try {
    sdk.start();
    logger.info('🚀 OpenTelemetry Tracing initialized successfully');
  } catch (err: any) {
    logger.error(`Failed to initialize OpenTelemetry tracing: ${err.message}`);
  }
}

/**
 * Attaches structured custom key-value attributes to the current trace span
 */
export function addSpanAttributes(attributes: Record<string, string>): void {
  try {
    const span = trace.getActiveSpan();
    if (span) {
      for (const [key, val] of Object.entries(attributes)) {
        if (val) {
          span.setAttribute(key, val);
        }
      }
    }
  } catch (err: any) {
    logger.warn(`Could not assign attributes to active trace span: ${err.message}`);
  }
}
export default {
  initializeTracing,
  addSpanAttributes,
};
