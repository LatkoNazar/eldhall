export interface JobCreate { text: string; operation?: 'uppercase' | 'reverse' }
export interface Job {
  id: string;
  text: string;
  operation: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export const jobCreateSchema = {
  type: 'object', additionalProperties: false, required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 10000 },
    operation: { type: 'string', enum: ['uppercase', 'reverse'], default: 'uppercase' },
  },
};
export const jobReadSchema = {
  type: 'object', required: ['id', 'text', 'operation', 'status', 'result', 'error', 'created_at', 'updated_at'],
  properties: {
    id: { type: 'string', format: 'uuid' }, text: { type: 'string' }, operation: { type: 'string' },
    status: { type: 'string' }, result: { type: ['string', 'null'] }, error: { type: ['string', 'null'] },
    created_at: { type: 'string' }, updated_at: { type: 'string' },
  },
};
