import { DetectionJob } from './job.types.js';
import { addDetectionJob } from '../../shared/queue/queues.js';
import { JobModel } from './job.model.js';
import { ValidationError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';

/**
 * Dispatches a pending detection job into the BullMQ processing pipeline.
 */
export async function dispatchJob(job: DetectionJob): Promise<void> {
  // 1. Validate: Only pending jobs can be dispatched
  if (job.status !== 'pending') {
    throw new ValidationError(
      `Only pending jobs can be dispatched to queue. Current status: '${job.status}'`,
    );
  }

  // 2. Update database job status to 'queued' FIRST to avoid background race conditions
  await JobModel.updateJobStatus(job.id, 'queued');

  // 3. Dispatch task with corresponding priority
  await addDetectionJob(
    job.id,
    job.org_id,
    {
      jobId: job.id,
      orgId: job.org_id,
      detectionModules: job.detection_modules,
    },
    job.priority,
  );

  logger.info(
    `Job ${job.id} successfully dispatched to detectionQueue (Priority: ${job.priority})`,
  );
}
