import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
export const { record, list, detail } = await rel(import.meta.url, '../../core/hundred-card-history.js', v);
