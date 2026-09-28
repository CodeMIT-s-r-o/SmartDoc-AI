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
   duration_seconds = 43200
   ```
4. Invite yourself (Cognito emails a temporary password):
   ```bash
   make invite EMAIL=you@example.com ADMIN=1
   ```

## Every session

```bash
make creds   # 12-hour credentials for the api container (recreates it if running)
make up
```

## Verification

- **The dev app role is scoped** (the first command succeeds, the second is denied):
  ```bash
  aws s3api put-object --profile smartdoc-dev-app --bucket <docs-bucket> --key users/probe/probe.txt --body README.md
  aws s3api put-object --profile smartdoc-dev-app --bucket <docs-bucket> --key probe.txt --body README.md
  ```
- **Sign-in works end to end:** open http://localhost:5173, choose "Sign in", use the invite
  (temporary password, then a new one), and the app shows your email, role and today's spend from
  `/api/me`. "Sign out" revokes the refresh token and ends the Cognito session.
  (`make login-url` still prints a bare authorize URL for debugging the managed-login step alone.)
- **Only `api` holds AWS credentials:**
  ```bash
  for s in api ai ai-worker web; do docker compose exec -T $s sh -c 'env | grep -c ^AWS_SECRET'; done
  ```
  Expected: `1` for api, `0` for the others.

## Teardown

Dev resources are not protected: `yarn workspace @smartdoc/cdk cdk destroy SmartDoc-Dev-Auth
SmartDoc-Dev-Storage --profile codemit` deletes the user pool and empties and deletes the bucket.
