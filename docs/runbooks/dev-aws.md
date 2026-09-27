# Runbook: dev AWS resources (Block 1.2)

Local development uses real AWS for Cognito and S3 (no emulators). This runbook creates the dev
stacks once and wires them into the local compose stack.

**Accounts and profiles:**
- `codemit`: the developer's admin profile. Used only from the laptop, for CDK and invites.
- `smartdoc-dev-app`: assumes `SmartDocDevApp`. It can reach only `users/*` in the dev docs bucket
  and is the only AWS identity a container ever gets (the `api` container, via `.env.aws`).

## One-time setup

1. Bootstrap CDK in eu-central-1 (us-east-1 comes with the edge stack in Weekend 2):
   ```bash
   make cdk-bootstrap
   ```
2. Deploy the dev stacks. This also writes `.env.dev-aws`:
   ```bash
   make cdk-dev
   ```
3. Add the dev app profile to `~/.aws/config`:
   ```ini
   [profile smartdoc-dev-app]
   role_arn = arn:aws:iam::<account-id>:role/SmartDocDevApp
   source_profile = codemit
   region = eu-central-1
   duration_seconds = 3600
   ```
4. Invite yourself (Cognito emails a temporary password):
   ```bash
   make invite EMAIL=you@example.com ADMIN=1
   ```

## Every session

```bash
make creds   # 1-hour credentials for the api container; rerun when they expire
make up
```

## Verification

- **The dev app role is scoped** (the first command succeeds, the second is denied):
  ```bash
  aws s3api put-object --profile smartdoc-dev-app --bucket <docs-bucket> --key users/probe/probe.txt --body README.md
  aws s3api put-object --profile smartdoc-dev-app --bucket <docs-bucket> --key probe.txt --body README.md
  ```
- **Managed login works:** open the URL from `make login-url`, sign in with the invite, set a new
  password, and land on `http://localhost:5173/auth/callback?code=...`. Until Block 1.4 wires the
  SPA, the `code` in the URL is the proof of success.
- **Only `api` holds AWS credentials:**
  ```bash
  for s in api ai ai-worker web; do docker compose exec -T $s sh -c 'env | grep -c ^AWS_SECRET'; done
  ```
  Expected: `1` for api, `0` for the others.

## Teardown

Dev resources are not protected: `yarn workspace @smartdoc/cdk cdk destroy SmartDoc-Dev-Auth
SmartDoc-Dev-Storage --profile codemit` deletes the user pool and empties and deletes the bucket.
