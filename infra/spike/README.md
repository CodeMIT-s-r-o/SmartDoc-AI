# Streaming spike (Phase 1 of docs/runbooks/deploy-prod.md)

Proves the risky part of the serverless layout before any app code depends on it: Server-Sent
Events from a Python Function URL, through a Node Function URL, through CloudFront, without being
cut or buffered. Both functions run behind the Lambda Web Adapter in response-streaming mode, as
the real `api` (NestJS) and `ai` (FastAPI) will.

```text
check.mjs ──► CloudFront ──OAC──► node (Function URL, AWS_IAM, RESPONSE_STREAM)
                                    └─ SigV4 ──► python (Function URL, AWS_IAM, RESPONSE_STREAM)
```

```bash
# deploy (about 3 minutes, a few cents), run the checks, tear down
cd infra/cdk && npx cdk -a "npx tsx bin/spike.ts" deploy SmartDoc-Spike --profile codemit
node infra/spike/check.mjs https://<distribution>.cloudfront.net <node-function-url>
cd infra/cdk && npx cdk -a "npx tsx bin/spike.ts" destroy SmartDoc-Spike --profile codemit
```
