import { App, type Environment, Tags } from 'aws-cdk-lib';
import { AuthStack } from './auth-stack.js';
import { STAGES, stackPrefix } from './config.js';
import { StorageStack } from './storage-stack.js';

/** Builds the whole app; shared by bin/app.ts and the tests. */
export function buildApp(app: App, env: Environment): App {
  Tags.of(app).add('project', 'smartdoc');

  for (const config of Object.values(STAGES)) {
    const prefix = stackPrefix(config.stage);
    const common = { env, config, terminationProtection: config.protect };

    const storage = new StorageStack(app, `${prefix}-Storage`, {
      ...common,
      devAppTrustedPrincipalArn: app.node.tryGetContext('devAppTrustedPrincipalArn') as
        string | undefined,
    });
    const auth = new AuthStack(app, `${prefix}-Auth`, common);

    for (const stack of [storage, auth]) {
      Tags.of(stack).add('stage', config.stage);
    }
  }
  return app;
}
