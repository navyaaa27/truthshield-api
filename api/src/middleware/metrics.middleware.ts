import { recordHttpRequest } from '../shared/metrics/metrics.service.js';

export const metricsMiddleware = recordHttpRequest();

export default metricsMiddleware;
