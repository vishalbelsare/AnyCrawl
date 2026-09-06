import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMonitorSchema } from '../../packages/libs/dist/index.js';
const files = [
 '../AnyCrawlDashboard/apps/web/app/price-monitoring/page.tsx',
 '../AnyCrawlDashboard/apps/web/app/website-monitoring/page.tsx',
 '../AnyCrawlDashboard/apps/web/components/monitors/landing/seo-page-configs.ts',
 'apps/docs/content/docs/general/monitors.mdx',
 'apps/docs/content/docs/general/monitors.zh-cn.mdx',
];
let count = 0;
for (const file of files) {
 const source = readFileSync(resolve(file), 'utf8');
 for (const match of source.matchAll(/-d '(\{[\s\S]*?\})'/g)) {
  const payload = JSON.parse(match[1]);
  if (!payload.cron_expression || !payload.targets) continue;
  createMonitorSchema.parse(payload); count++;
 }
}
if (count < 5) throw new Error(`Expected at least 5 monitor examples; found ${count}`);
console.log(`${count} public monitor create examples match the actual schema`);
