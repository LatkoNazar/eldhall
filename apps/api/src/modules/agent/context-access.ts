import { createHash } from 'node:crypto';
import { parseSkillContext, supportContextRequestSchema, type ContextMessage, type ContextSkill, type SupportContextCatalog, type SupportContextDetails, type SupportContextRequest } from './context.js';
import type { BusinessTool } from '../../integrations/mcp.js';

export class SupportContextError extends Error {
  constructor() { super('Requested context is unavailable or too large; use advertised IDs and request fewer items'); this.name = 'SupportContextError'; }
}
export function createSupportContextAccess(input: {
  skills: ContextSkill[];
  tools: BusinessTool[];
  messages: ContextMessage[];
  assertActive: () => Promise<void>;
  verifyTools?: (refs: { integrationId: string; name: string }[]) => Promise<void>;
}) {
  const skills = structuredClone(input.skills), tools = structuredClone(input.tools), messages = structuredClone(input.messages);
  const catalog: SupportContextCatalog = {
    skills: skills.map(skill => {
      const parsed = parseSkillContext(skill);
      return { id: skill.id, name: skill.name, revision: skill.revision, purpose: parsed.purpose, activation: parsed.activation };
    }),
    tools: tools.map(tool => ({
      integrationId: tool.integrationId, name: tool.name, description: tool.description.slice(0, 160),
      arguments: Object.keys(tool.inputSchema.properties ?? {}).map(key => key + (tool.inputSchema.required?.includes(key) ? '' : '?')),
      ...(tool.batchRead?{batchRead:true as const}:{}),
    })),
  };
  return {
    catalog,
    async load(raw: SupportContextRequest, signal?: AbortSignal): Promise<SupportContextDetails> {
      const parsed = supportContextRequestSchema.safeParse(raw);
      if (!parsed.success) throw new SupportContextError();
      const request = parsed.data;
      if (new Set(request.skillIds).size !== (request.skillIds?.length ?? 0) ||
          new Set(request.messageIds).size !== (request.messageIds?.length ?? 0) ||
          new Set(request.toolRefs?.map(ref => JSON.stringify(ref))).size !== (request.toolRefs?.length ?? 0)) throw new SupportContextError();
      await input.assertActive(); signal?.throwIfAborted();
      await input.verifyTools?.(request.toolRefs ?? []);
      // Resolve the complete request before returning any item; foreign IDs never yield a partial response.
      const selectedSkills = (request.skillIds ?? []).map(id => skills.find(skill => skill.id === id));
      const selectedTools = (request.toolRefs ?? []).map(ref => tools.find(tool => tool.integrationId === ref.integrationId && tool.name === ref.name));
      const selectedMessages = (request.messageIds ?? []).map(id => messages.find(message => message.id === id));
      if (selectedSkills.some(row => !row) || selectedTools.some(row => !row) || selectedMessages.some(row => !row)) throw new SupportContextError();
      const details: SupportContextDetails = {
        skills: selectedSkills.map(skill => {
          const content = parseSkillContext(skill!).content;
          return { id: skill!.id, name: skill!.name, revision: skill!.revision, content, contentHash: createHash('sha256').update(content).digest('hex') };
        }),
        tools: selectedTools.map(tool => ({ integrationId: tool!.integrationId, name: tool!.name, description: tool!.description, inputSchema: structuredClone(tool!.inputSchema) })),
        messages: selectedMessages.map(message => structuredClone(message!)),
      };
      if (Buffer.byteLength(JSON.stringify(details)) > 65_536) throw new SupportContextError();
      await input.verifyTools?.(request.toolRefs ?? []);
      await input.assertActive(); signal?.throwIfAborted();
      return details;
    },
  };
}
