import { App, Tags } from 'aws-cdk-lib';
import { REGION } from '../lib/config.js';
import { SpikeStack } from '../lib/spike-stack.js';

// npx cdk -a "npx tsx bin/spike.ts" deploy SmartDoc-Spike: kept apart from the real app.
const app = new App();
Tags.of(app).add('project', 'smartdoc');
new SpikeStack(app, 'SmartDoc-Spike', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION },
});
