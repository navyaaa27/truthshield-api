import { env } from './env.js';
import { logger } from '../utils/logger.js';

interface ServiceStatus {
  hiveEnabled: boolean;
  rekognitionEnabled: boolean;
  googleFactCheckEnabled: boolean;
  anthropicEnabled: boolean;
}

/**
 * Validates which external API services are configured at startup.
 * Never throws on missing keys — logs warnings only for graceful degradation.
 */
export function validateExternalServices(): ServiceStatus {
  const status: ServiceStatus = {
    hiveEnabled: !!env.HIVE_MODERATION_API_KEY,
    rekognitionEnabled: !!env.AWS_REKOGNITION_REGION,
    googleFactCheckEnabled: !!env.GOOGLE_FACT_CHECK_API_KEY,
    anthropicEnabled: !!env.ANTHROPIC_API_KEY,
  };

  logger.info('──────────────────────────────────────────');
  logger.info('  External Services Configuration Status  ');
  logger.info('──────────────────────────────────────────');
  logger.info(`  ${status.hiveEnabled ? '[✓]' : '[✗]'} Hive Moderation: ${status.hiveEnabled ? 'configured' : 'NOT configured'}`);
  logger.info(`  ${status.rekognitionEnabled ? '[✓]' : '[✗]'} AWS Rekognition: ${status.rekognitionEnabled ? 'configured' : 'NOT configured'}`);
  logger.info(`  ${status.googleFactCheckEnabled ? '[✓]' : '[✗]'} Google Fact Check: ${status.googleFactCheckEnabled ? 'configured' : 'NOT configured'}`);
  logger.info(`  ${status.anthropicEnabled ? '[✓]' : '[✗]'} Anthropic Claude: ${status.anthropicEnabled ? 'configured' : 'NOT configured'}`);
  logger.info('──────────────────────────────────────────');

  if (!status.hiveEnabled) {
    logger.warn('Hive Moderation API key not set — deepfake detection will be unavailable.');
  }
  if (!status.anthropicEnabled) {
    logger.warn('Anthropic API key not set — AI-powered analysis features will use fallback templates.');
  }
  if (!status.googleFactCheckEnabled) {
    logger.warn('Google Fact Check API key not set — fact-checking will rely on heuristic analysis only.');
  }

  return status;
}

export { ServiceStatus };
