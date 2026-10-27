import {
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_ecr_assets as assets,
  aws_iam as iam,
  aws_lambda as lambda,
  CfnOutput,
  Duration,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';

const SPIKE_DIR = fileURLToPath(new URL('../../spike', import.meta.url));

/**
 * Throwaway (docs/runbooks/deploy-prod.md, Phase 1): does an SSE stream survive CloudFront → Node Function
 * URL → Python Function URL, both in response-streaming mode behind the Lambda Web Adapter?
 */
export class SpikeStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const image = (dir: string) =>
      lambda.DockerImageCode.fromImageAsset(`${SPIKE_DIR}/${dir}`, {
        platform: assets.Platform.LINUX_ARM64,
      });
    const streaming = {
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(3),
    };

    const ai = new lambda.DockerImageFunction(this, 'Python', {
      ...streaming,
      code: image('python'),
    });
    const aiUrl = ai.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    const api = new lambda.DockerImageFunction(this, 'Node', {
      ...streaming,
      code: image('node'),
      environment: { AI_URL: aiUrl.url },
    });
    // A new Function URL needs both lambda:InvokeFunctionUrl and lambda:InvokeFunction (the
    // latter limited to invocations through the URL); grantInvokeUrl adds only the first.
    aiUrl.grantInvokeUrl(api);
    api.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [ai.functionArn],
        conditions: { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
      }),
    );
    const apiUrl = api.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'smartdoc streaming spike',
      defaultBehavior: {
        origin: origins.FunctionUrlOrigin.withOriginAccessControl(apiUrl, {
          readTimeout: Duration.seconds(60),
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
    });

    api.addPermission('InvokeFromCdn', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      invokedViaFunctionUrl: true,
      sourceArn: distribution.distributionArn,
    });

    new CfnOutput(this, 'CdnUrl', { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, 'NodeFunctionUrl', { value: apiUrl.url });
  }
}
