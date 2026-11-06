import type { SupportStore } from '../modules/support/store.js';
import type { SupportConfig } from './config.js';
import { sameClassificationConfig } from '../modules/agent/classification.js';
import { fingerprint } from './permissions.js';

/** Mount reviewed prose and initial business guards; never execute skill contents. */
export async function bootstrapSupportConfig(store: SupportStore, config: SupportConfig): Promise<void> {
  const known = await store.businessesList();
  const businessIds = new Set([...known.map(row => row.id), ...config.businesses.map(row => row.id)]);
  for (const business of config.businesses) {
    if (known.some(row => row.slug === business.slug && row.id !== business.id) || known.some(row => row.id === business.id && row.slug !== business.slug)) throw new Error('Configured business slug conflicts with an existing business');
  }
  const existingKnowledge = new Map<string, Awaited<ReturnType<SupportStore['knowledge']>>[number]>();
  const existingSkills = new Map<string, Awaited<ReturnType<SupportStore['skills']>>[number]>();
  const existingSettings = new Map<string, Awaited<ReturnType<SupportStore['settings']>>>();
  const classifierStates = new Map<string, Awaited<ReturnType<SupportStore['classificationState']>>>();
  for (const business of known) {
    for (const source of await store.knowledge(business.id)) existingKnowledge.set(source.id, source);
    for (const skill of await store.skills(business.id)) existingSkills.set(skill.id, skill);
    existingSettings.set(business.id, await store.settings(business.id));
    classifierStates.set(business.id, await store.classificationState(business.id));
  }
  // Validate every reference/revision before writing any bootstrap rows.
  for (const row of [...config.knowledge, ...config.skills, ...config.integrations, ...config.classifications, ...config.guardPolicies, ...config.externalKnowledge, ...config.catalogs]) if (!businessIds.has(row.businessId)) throw new Error('Support config references an unknown business');
  for (const source of config.knowledge) {
    const old = existingKnowledge.get(source.id);
    if (old && (old.businessId !== source.businessId || (old.version === source.version && ['title', 'category', 'content', 'status'].some(key => old[key as keyof typeof old] !== source[key as keyof typeof source])))) throw new Error('Configured document requires a new version or a distinct id');
  }
  for (const skill of config.skills) {
    const old = existingSkills.get(skill.id);
    if (old && (old.businessId !== skill.businessId || (old.revision === skill.revision && ['name', 'content', 'enabled'].some(key => old[key as keyof typeof old] !== skill[key as keyof typeof skill])))) throw new Error('Configured skill requires a new revision or a distinct id');
  }
  for (const { businessId, ...classification } of config.classifications) {
    const old = existingSettings.get(businessId)?.classification;
    if (old && old.revision === classification.revision && !sameClassificationConfig(old, classification)) throw new Error('Configured classification requires a new revision');
  }
  for (const policy of config.guardPolicies) {
    const old=existingSettings.get(policy.businessId);
    if(old&&(old.guardRevision??0)===policy.revision&&fingerprint(old.guards??[])!==fingerprint(policy.guards)) throw new Error('Configured guards require a new revision');
  }
  for (const business of config.businesses) if (!known.some(row => row.id === business.id)) await store.createBusiness(business);
  for (const source of config.knowledge) {
    const old = existingKnowledge.get(source.id);
    if (!old || source.version > old.version) await store.saveKnowledge(source, old?.version);
  }
  for (const skill of config.skills) {
    const old = existingSkills.get(skill.id);
    if (!old || skill.revision > old.revision) await store.saveSkill(skill,old?.revision);
  }
  for (const { businessId, ...classification } of config.classifications) {
    const settings = existingSettings.get(businessId) ?? await store.settings(businessId);
    if (classification.revision > (classifierStates.get(businessId)?.revision ?? 0)) {
      await store.saveSettings({ ...settings, classification, version: settings.version + 1 }, settings.version);
    }
  }
  for(const policy of config.guardPolicies) {
    const settings=await store.settings(policy.businessId);
    if(policy.revision>(settings.guardRevision??0)) await store.saveSettings({...settings,version:settings.version+1,guards:policy.guards,guardRevision:policy.revision},settings.version);
  }
  for (const catalog of config.catalogs) await store.integrationStore.bootstrap({ businessId: catalog.businessId, manifest: catalog.manifest, policy: catalog.policy,
    connectionRevision: catalog.connectionRevision,
    connectionHash: fingerprint({ url: catalog.url, credentialEnv: catalog.credentialEnv, upstreamTargetFingerprint:catalog.upstreamTargetFingerprint,upstreamBusinessId: catalog.upstreamBusinessId ?? null, customerIdMap: catalog.customerIdMap ?? null }),
  });
}
