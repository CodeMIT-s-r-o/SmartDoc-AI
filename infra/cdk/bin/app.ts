import { App } from 'aws-cdk-lib';
import { buildApp } from '../lib/app.js';
import { REGION } from '../lib/config.js';

// The account comes from the CLI profile (CDK_DEFAULT_ACCOUNT); the region is pinned.
buildApp(new App(), { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION });
