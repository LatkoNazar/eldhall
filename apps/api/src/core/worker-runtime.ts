import type { ConsumeMessage, ConfirmChannel } from 'amqplib';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_RETRIES, parseJobMessage, retryAttempt, type JobMessage } from './queue.js';
import type { JobStore } from '../modules/jobs/repository.js';
import { executeJob, MissingJob, UnsupportedOperation } from '../modules/jobs/service.js';

export interface WorkerDependencies {
  store: JobStore;
  channel: Pick<ConfirmChannel, 'ack' | 'nack'>;
  publish: (message: JobMessage, attempt?: number) => Promise<void>;
  cacheResult: (id: string, result: string | null) => Promise<void>;
  onRetry?: (id: string, attempt: number) => void;
  pause?: (milliseconds: number) => Promise<unknown>;
}

export async function processMessage(message: ConsumeMessage, dependencies: WorkerDependencies): Promise<void> {
  let payload;
  let attempt;
  try { payload = parseJobMessage(message.content); attempt = retryAttempt(message.properties.headers); }
  catch { dependencies.channel.nack(message, false, false); return; }
  try {
    const result = await executeJob(dependencies.store, payload.jobId);
    await dependencies.cacheResult(payload.jobId, result);
  } catch (error) {
    if (error instanceof MissingJob || error instanceof UnsupportedOperation) {
      dependencies.channel.nack(message, false, false);
      return;
    }
    if (attempt < MAX_RETRIES) {
      await (dependencies.pause ?? delay)(Math.min(1000 * 2 ** attempt, 8000));
      // A confirmed replacement must exist before acknowledging this delivery.
      await dependencies.publish(payload, attempt + 1);
      dependencies.onRetry?.(payload.jobId, attempt + 1);
      dependencies.channel.ack(message);
      return;
    }
    // A succeeded row stays succeeded even if the optional result cache failed.
    const job = await dependencies.store.find(payload.jobId);
    if (job && job.status !== 'succeeded') await dependencies.store.failed(payload.jobId, 'Background job failed after retries');
    dependencies.channel.nack(message, false, false);
    return;
  }
  dependencies.channel.ack(message);
}
