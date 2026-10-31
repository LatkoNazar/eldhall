import { sameClassificationConfig, type ClassificationConfig } from '../agent/classification.js';

/** Private persisted watermark; never returned as the public classifier configuration. */
export type StoredClassification = ClassificationConfig | { disabled: true; revision: number } | null | undefined;
export interface ClassificationState { revision: number; disabled: boolean }
const disabled = (value: StoredClassification): value is { disabled: true; revision: number } => !!value && 'disabled' in value && value.disabled === true;
export const visibleClassification = (value: StoredClassification): ClassificationConfig | null => disabled(value) ? null : value ?? null;
export const classificationState = (value: StoredClassification): ClassificationState => ({ revision: value?.revision ?? 0, disabled: disabled(value) });
export function canReplaceClassification(previous: StoredClassification, next: ClassificationConfig | null | undefined): boolean {
  if (!previous || !next) return true;
  if (disabled(previous)) return next.revision > previous.revision;
  return next.revision > previous.revision || (next.revision === previous.revision && sameClassificationConfig(previous, next));
}
export function storedClassification(previous: StoredClassification, next: ClassificationConfig | null | undefined): StoredClassification {
  if (next === undefined) return previous ?? null;
  return next === null ? { disabled: true, revision: previous?.revision ?? 0 } : next;
}
