import dns from 'dns';
import { ValidationError } from '../middleware/errorHandler.js';

/**
 * Validates that the provided URL uses HTTPS and does not resolve to local,
 * loopback, or private cloud/infrastructure networks (SSRF prevention).
 *
 * @param url The external URL to be fetched.
 * @throws ValidationError if validation fails.
 */
export async function validateUrlSafety(url: string): Promise<void> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (err) {
    throw new ValidationError('Invalid URL format');
  }

  // 1. Reject non-HTTPS protocols
  if (parsedUrl.protocol !== 'https:') {
    throw new ValidationError(
      'Invalid protocol: only secure HTTPS is allowed for external scraping',
    );
  }

  const hostname = parsedUrl.hostname.toLowerCase();

  // 2. Direct string checking against blocked hostnames and loopbacks
  const blockedHostnames = ['localhost', 'metadata.google.internal'];
  if (blockedHostnames.includes(hostname)) {
    throw new ValidationError(`Access to blocked host is denied: ${hostname}`);
  }

  if (
    hostname === '0.0.0.0' ||
    hostname === '169.254.169.254' ||
    hostname.startsWith('127.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.')
  ) {
    throw new ValidationError(`Access to local or private IP ranges is denied: ${hostname}`);
  }

  // Class B private network check (172.16.0.0 - 172.31.255.255)
  if (hostname.startsWith('172.')) {
    const parts = hostname.split('.');
    if (parts.length >= 2) {
      const secondOctet = parseInt(parts[1], 10);
      if (!isNaN(secondOctet) && secondOctet >= 16 && secondOctet <= 31) {
        throw new ValidationError(`Access to private IP ranges is denied: ${hostname}`);
      }
    }
  }

  // 3. Perform DNS resolution to prevent DNS rebinding SSRF
  try {
    const addresses = await dns.promises.lookup(parsedUrl.hostname, { all: true });
    for (const record of addresses) {
      const ip = record.address;

      if (
        ip === '169.254.169.254' ||
        ip === '0.0.0.0' ||
        ip === '::1' ||
        ip === '::' ||
        ip.startsWith('127.') ||
        ip.startsWith('10.') ||
        ip.startsWith('192.168.')
      ) {
        throw new ValidationError(
          `DNS resolution points to forbidden private or loopback address: ${ip}`,
        );
      }

      if (ip.startsWith('172.')) {
        const parts = ip.split('.');
        if (parts.length >= 2) {
          const secondOctet = parseInt(parts[1], 10);
          if (!isNaN(secondOctet) && secondOctet >= 16 && secondOctet <= 31) {
            throw new ValidationError(
              `DNS resolution points to forbidden private Class B address: ${ip}`,
            );
          }
        }
      }
    }
  } catch (err: any) {
    if (err instanceof ValidationError) {
      throw err;
    }
    throw new ValidationError(`Failed to resolve host DNS: ${parsedUrl.hostname}`);
  }
}
