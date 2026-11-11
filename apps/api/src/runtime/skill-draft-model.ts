import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import type { GuardDraftInput, GuardDraftModel } from '../modules/support/guard-drafts.js';
import type { SkillDraftInput, SkillDraftModel } from '../modules/support/skill-drafts.js';
import type { DshSupportOptions } from './dsh-model.js';
import { childEnvironment, prepareProfile } from './profile.js';

type DraftOptions = DshSupportOptions & { model: string };

/** A one-turn authoring profile with no support gateway or persistent conversation. */
class DshDraftModel<Input> {
  constructor(private readonly options: DraftOptions, private readonly purpose: 'skill-draft' | 'guard-draft') {}

  async generate(input: Input, businessId: string, parentSignal: AbortSignal): Promise<unknown> {
    const timeoutMs = Math.min(this.options.timeoutMs ?? 50_000, 50_000);
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)]);
    signal.throwIfAborted();
    const homeRoot = this.options.homeRoot ?? join(tmpdir(), 'support-dsh');
    await mkdir(homeRoot, { recursive: true });
    const temporary = await mkdtemp(join(homeRoot, `${this.purpose}-`));
    let runtime: DeepSeekHarness | undefined;
    let closing: Promise<void> | undefined;
    const close = () => { if (runtime) closing ??= runtime.close(); return closing; };
    const cancel = () => { void close()?.catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const provider = this.options.provider === 'local' ? 'support-local' : this.options.provider;
      const profile = await prepareProfile({ homeRoot: temporary, businessId, conversationId: 'draft', ownershipVersion: 0,
        provider, model: this.options.model, baseURL: this.options.baseURL, purpose: this.purpose });
      signal.throwIfAborted();
      runtime = new DeepSeekHarness({
        profile: 'support', dshHome: profile.home, processCwd: profile.workspace, cwd: profile.workspace,
        provider, model: this.options.model, maxTokens: 4096, initializeTimeoutMs: Math.min(timeoutMs, 30_000),
        disposeEofGraceMs: 300, disposeGraceMs: 1000,
        env: childEnvironment({ apiKey: this.options.apiKey || (this.options.baseURL ? 'local-endpoint' : ''),
          gatewayUrl: '', capability: '', maxToolCalls: 0, home: profile.home }),
      });
      await runtime.start();
      signal.throwIfAborted();
      const result = await runtime.session(profile.sessionId).run([{ type: 'text', text: JSON.stringify(input) }]);
      signal.throwIfAborted();
      const response = result.finalResponse.trim();
      if (!response || response.length > 25_000) throw new Error('Invalid draft response size');
      const fenced = /^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i.exec(response);
      return JSON.parse(fenced?.[1] ?? response) as unknown;
    } finally {
      signal.removeEventListener('abort', cancel);
      try { await close(); } finally { await rm(temporary, { recursive: true, force: true }); }
    }
  }
}

export class DshSkillDraftModel extends DshDraftModel<SkillDraftInput> implements SkillDraftModel {
  constructor(options: DraftOptions) { super(options, 'skill-draft'); }
}

export class DshGuardDraftModel extends DshDraftModel<GuardDraftInput> implements GuardDraftModel {
  constructor(options: DraftOptions) { super(options, 'guard-draft'); }
}
