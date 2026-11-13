import { zh } from './i18n/zh';
import { machinesZh } from './i18n/machines';
import { producerActivityZh } from './i18n/producer-activity';
import { designGoalsZh } from './i18n/design-goals';
import { independentCheckZh } from './i18n/independent-check';
import { nightlyGatesZh } from './i18n/nightly-gates';
/** Expected translations in rendering tests share the production catalogs. */
export const testTranslations = { ...zh, ...machinesZh, ...producerActivityZh, ...designGoalsZh, ...independentCheckZh, ...nightlyGatesZh };
