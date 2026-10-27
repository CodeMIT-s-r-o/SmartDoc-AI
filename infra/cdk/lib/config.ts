export type Stage = 'dev' | 'prod';

export interface StageConfig {
  stage: Stage;
  /** Browser origins allowed by S3 CORS and used for Cognito redirects. */
  webOrigins: string[];
  /** Production resources are retained and protected; dev resources can be torn down freely. */
  protect: boolean;
}

export const REGION = 'eu-central-1';

export const STAGES: Record<Stage, StageConfig> = {
  // Localhost origins exist only on dev resources, never on the prod client or bucket.
  dev: { stage: 'dev', webOrigins: ['http://localhost:5173'], protect: false },
  prod: { stage: 'prod', webOrigins: ['https://smartdoc.codemit.sk'], protect: true },
};

/** SSM path for non-secret config consumed by the apps and CI (see docs/planning/IMPLEMENTATION_PLAN.md §3.4). */
export const configParam = (stage: Stage, name: string): string =>
  `/smartdoc/${stage}/config/${name}`;

export const stackPrefix = (stage: Stage): string =>
  `SmartDoc-${stage.charAt(0).toUpperCase()}${stage.slice(1)}`;
