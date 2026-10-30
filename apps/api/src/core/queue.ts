import amqp, { type Channel, type ChannelModel, type ConfirmChannel } from 'amqplib';
import type { Settings } from './config.js';

export const JOB_QUEUE = 'jobs.transform.node.v1';
export const MAX_RETRIES = 3;
export interface JobMessage { version: 1; jobId: string }

export function brokerOptions(settings: Settings) {
  return {
    protocol: 'amqp', hostname: settings.rabbitmqHost, port: settings.rabbitmqPort,
    username: settings.rabbitmqUser, password: settings.rabbitmqPassword,
    // amqplib unescapes vhost even for object options; encode exactly once first.
    vhost: encodeURIComponent(settings.rabbitmqVhost), heartbeat: 15,
  };
}

export async function connectBroker(settings: Settings): Promise<ChannelModel> {
  const connection = await amqp.connect(brokerOptions(settings), { timeout: 3000 });
  connection.on('error', () => console.warn('RabbitMQ connection unavailable'));
  return connection;
}

export async function assertJobQueue(channel: Channel): Promise<void> {
  await channel.assertQueue(JOB_QUEUE, { durable: true });
}

export async function publishConfirmed(channel: ConfirmChannel, message: JobMessage, attempt = 0): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('RabbitMQ confirmation timed out')), 5000);
    try {
      channel.sendToQueue(JOB_QUEUE, Buffer.from(JSON.stringify(message)), {
        persistent: true, contentType: 'application/json', messageId: message.jobId,
        headers: { 'x-attempt': attempt },
      }, error => {
        clearTimeout(timeout);
        if (error) reject(new Error('RabbitMQ publish was not confirmed'));
        else resolve();
      });
    } catch {
      clearTimeout(timeout);
      reject(new Error('RabbitMQ publish failed'));
    }
  });
}

export async function dispatchJob(settings: Settings, jobId: string): Promise<void> {
  const connection = await connectBroker(settings);
  try {
    const channel = await connection.createConfirmChannel();
    channel.on('error', () => console.warn('RabbitMQ publisher channel unavailable'));
    try {
      await assertJobQueue(channel);
      await publishConfirmed(channel, { version: 1, jobId });
    } finally { await channel.close().catch(() => undefined); }
  } finally { await connection.close().catch(() => undefined); }
}

export function parseJobMessage(content: Buffer): JobMessage {
  const parsed: unknown = JSON.parse(content.toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Invalid job envelope');
  const value = parsed as Record<string, unknown>;
  if (value.version !== 1 || typeof value.jobId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.jobId)) {
    throw new Error('Invalid job envelope');
  }
  return { version: 1, jobId: value.jobId };
}

export function retryAttempt(headers: Record<string, unknown> | undefined): number {
  const attempt = headers?.['x-attempt'] ?? 0;
  if (!Number.isInteger(attempt) || typeof attempt !== 'number' || attempt < 0 || attempt > MAX_RETRIES) {
    throw new Error('Invalid retry attempt');
  }
  return attempt;
}
