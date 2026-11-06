import type { Business, Metrics } from './contracts.js';
import type { SupportStore } from './store.js';

export interface Workspace { business: Pick<Business, 'id' | 'slug' | 'name' | 'currency'> }
export const publicBusiness = ({id,slug,name,currency}:Business): Workspace['business'] => ({id,slug,name,currency});
/** A fixed deployment binding never retargets itself to a URL/body supplied business. */
export const businessVisible = (binding: string | undefined, id: string) => !binding || binding === id;
export async function scopedMetrics(store:SupportStore,businessId:string):Promise<Metrics>{return store.metrics(businessId);}
