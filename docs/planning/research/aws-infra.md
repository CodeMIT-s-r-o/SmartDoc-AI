# SmartDoc AI: AWS deployment design (aws-infra)

Research date: 2026-09-25. Region: eu-central-1, unless a service has to live in us-east-1. Prices are USD list prices at 730 h per month. EC2, EBS and CloudWatch prices for Frankfurt come from the AWS public price-list JSON, published 2026-09-24 and 2026-09-22. Anything I could not verify is marked **[UNVERIFIED]**.

---

## 0. Decisions at a glance

| Area | Recommendation | Why (the interview answer) |
|---|---|---|
| Compute | **1× t4g.small** (2 vCPU Graviton2, 2 GiB), AL2023 arm64, 2 GiB swap, CPU credits in `STANDARD` mode | It costs $0 until 2026-12-31 under the T4g free trial. Resizing to t4g.medium means a stop/start and one CDK line, and I would decide it from measured `docker stats`, not guesses. |
| Storage | 20 GiB gp3 root + **separate 10 GiB gp3 data volume** (Postgres), `RemovalPolicy.SNAPSHOT` | If the instance is replaced, the database survives. The data volume is snapshotted daily by DLM. |
| Edge/TLS | **CloudFront in front of S3 and EC2**, one domain `smartdoc.codemit.sk`, `/api/*` goes to the EC2 origin | The API is same-origin, so there is no CORS or preflight. WAF and DDoS protection sit in front of the API and EC2 stays hidden. SSE streaming works (details in §2). |
| Origin TLS | Caddy on EC2 gets a Let's Encrypt cert for `origin.smartdoc.codemit.sk`. The SG allows 443 only from the CloudFront prefix list, plus a secret-header check | TLS runs end to end. The origin can't be reached directly. |
| CDN pricing | **CloudFront flat-rate Free plan** ($0, WAF included), subscribed through CFN `AWS::PricingPlanManager::Subscription` | WAF and the Route 53 zone cost $0. There are no overage charges. |
| Auth | Cognito **Essentials** (free up to 10k MAU), `selfSignUpEnabled: false`, **managed login + auth code + PKCE** through `react-oidc-context`, `aws-jwt-verify` checking **access tokens** in NestJS | No login UI code to write. The invite and first-password flow comes built in. |
| Uploads | **Presigned POST** (`content-length-range`, fixed `Content-Type`, server-built key `users/{sub}/…`), private bucket with SSE-S3 | Size can only be enforced with POST, not with a presigned PUT. |
| Local dev | A real **dev** S3 bucket and a dev Cognito pool, with SSO credentials. No MinIO or LocalStack | MinIO CE was archived in Feb 2026. LocalStack has required an auth token since Mar 2026. Cognito needs real AWS anyway. |
| Secrets | **SSM Parameter Store SecureString** (free), written to an `.env` or compose secrets file at deploy time | Secrets Manager would add $0.40 per secret per month for rotation I don't need. |
| CI/CD | GitHub Actions on **`ubuntu-24.04-arm`** (native arm64, free minutes even for private repos) → ECR → **SSM Run Command** runs `docker compose pull && up`. GitHub OIDC, no keys | No QEMU, no SSH, no static AWS keys anywhere. |
| Frontend deploy | `aws s3 sync` + invalidating only `/index.html`, from CI | App releases stay separate from infrastructure deploys, and a release takes seconds instead of a CDK deploy. |
| Cost | **About $21.6/month at list price, about $7.6/month until 2026-12-31** (t4g.medium: about $35.6) | Of that, $3.65 is the public IPv4 charge. OpenAI spend is extra. |

```
Browser ──HTTPS──► CloudFront (smartdoc.codemit.sk, WAF, flat-rate Free)
                    ├─ default  → S3 SPA bucket (OAC)  [CloudFront Function: SPA rewrite]
                    └─ /api/*   → https://origin.smartdoc.codemit.sk (EIP)  CachingDisabled, AllViewerExceptHostHeader
                                    EC2 t4g.small (AL2023, Docker Compose)
                                    ├─ caddy:443  (LE cert, checks X-Origin-Verify) → api:3000
                                    ├─ api   (NestJS, Drizzle)  ──► ai:8000 (FastAPI, internal only)
                                    ├─ ai    (Python RAG)       ──► OpenAI API (egress via public IPv4)
                                    └─ db    (pgvector/pgvector:0.8.x-pg18) → /data (separate EBS)
Browser ──presigned POST──► S3 docs bucket (eu-central-1)   ◄── api/ai via instance role (S3 gateway endpoint)
Browser ──OIDC/PKCE──► Cognito managed login
```

---

## 1. EC2 sizing, Free Tier and monthly cost

### Verified unit prices (eu-central-1)
| Item | Price | Monthly |
|---|---|---|
| t4g.small (2 vCPU, 2 GiB) | $0.0192/h | **$14.02** |
| t4g.medium (2 vCPU, 4 GiB) | $0.0384/h | **$28.03** |
| t4g.large (2 vCPU, 8 GiB) | $0.0768/h | $56.06 |
| EBS gp3 | $0.0952/GB-mo (3,000 IOPS and 125 MB/s included) | 30 GB = $2.86 |
| EBS snapshot (standard) | $0.054/GB-mo | |
| Public IPv4, including an attached EIP | $0.005/h, in use or idle, **no free tier** | $3.65 |
| S3 gateway endpoint | free | |

### Free Tier rules (verified)
- **Accounts created on or after 2025-07-15:** you get $100 in credits, plus up to $100 more for onboarding tasks. On the "Free plan" the account closes after 6 months or when the credits run out, whichever comes first. **Accounts created before that date keep the legacy model.** A catch: an account "using AWS Free Tier" **can't subscribe to the CloudFront flat-rate plans**.
- **The T4g trial is separate and applies to every account.** It gives 750 t4g.small hours per month, aggregated across regions, **until 2026-12-31**. It covers t4g.small only. Surplus CPU credits are still billed, so set `CpuCredits.STANDARD`, because T4g defaults to `unlimited`.
- Other always-free allowances that still apply: 100 GB/month of internet egress across all services, CloudFront PAYG (1 TB, 10M requests, 2M CloudFront Functions invocations), CloudWatch (10 metrics, 10 alarms, 5 GB of logs), Cognito (10k MAU on Lite and Essentials), ECR (500 MB for 12 months, new accounts only).

### RAM budget ([ESTIMATE], to be measured with `docker stats` and the CloudWatch agent's `mem_used_percent`)
| Component | Steady | Spike |
|---|---|---|
| AL2023 + dockerd + SSM agent + CloudWatch agent | 350–450 MB | |
| Postgres 18 + pgvector (`shared_buffers=256MB`, small corpus) | 300–400 MB | index build +200 MB |
| NestJS (`--max-old-space-size=256`) | 150–250 MB | |
| FastAPI + LangChain/LlamaIndex + PDF parser | 250–450 MB | ingestion of a large PDF +300–500 MB |
| Caddy | 30–50 MB | |
| **Total** | **about 1.1–1.6 GB** | about 2.2 GB (swap absorbs it) |
| + FlashRank reranker (ONNX, about 34 MB model, no torch) | +100–150 MB | fits t4g.small |
| + torch cross-encoder (e.g. bge-reranker-base) | +1.5–2 GB | **needs t4g.medium**, and it is slow on 2 burstable vCPUs |

**Recommendation:** start on t4g.small with a 2 GiB swapfile and a compose `mem_limit` per service, ingesting one document at a time. If you add reranking, use FlashRank or a hosted rerank API rather than torch. Resize to t4g.medium only if measurements say so. `InstanceType` changes on `AWS::EC2::Instance` cause a stop/start (a "some interruption" update), not a replacement.

### Monthly cost estimate
| Line item | t4g.small (list) | t4g.small with T4g trial (to 2026-12-31) | t4g.medium |
|---|---|---|---|
| EC2 compute | 14.02 | 0.00 | 28.03 |
| EBS gp3 30 GB (20 root + 10 data) | 2.86 | 2.86 | 2.86 |
| Public IPv4 (EIP) | 3.65 | 3.65 | 3.65 |
| EBS snapshots (DLM 7× daily, about 5 GB billed) [EST] | 0.30 | 0.30 | 0.30 |
| S3: docs, backups, SPA, artifacts (<2 GB; covered by the plan's 5 GB S3 credit) | ~0.05 | ~0.05 | ~0.05 |
| ECR (about 2 GB, lifecycle keeps the last 5 images per repo) | 0.20 | 0.20 | 0.20 |
| CloudFront + WAF (flat-rate Free) | 0.00 | 0.00 | 0.00 |
| Route 53 zone codemit.sk (**$0 if attached to the flat-rate plan**; probably already paid) | 0.50 | 0.50 | 0.50 |
| Route 53 health check (first 50 for AWS endpoints are free) [UNVERIFIED that a CloudFront target counts; otherwise $0.75] | 0.00 | 0.00 | 0.00 |
| Cognito (<10k MAU) | 0.00 | 0.00 | 0.00 |
| SSM Parameter Store (standard), Session Manager, Run Command | 0.00 | 0.00 | 0.00 |
| CloudWatch (<5 GB logs, 2 custom metrics, ≤10 alarms) | 0.00 | 0.00 | 0.00 |
| Data transfer (EC2→CloudFront is free; <100 GB internet egress) | 0.00 | 0.00 | 0.00 |
| Budgets (non-action), Cost Anomaly Detection, SNS email | 0.00 | 0.00 | 0.00 |
| **Total** | **≈ $21.6** | **≈ $7.6** | **≈ $35.6** |

Adjustments:
- **If you can't use the flat-rate plan (PAYG):** CloudFront is still $0 inside the always-free tier. Either drop WAF or pay about $5 per web ACL plus $1 per rule plus $0.60 per million requests [WAF prices not re-verified].
- **Where costs grow beyond the free tier:**
  - CloudWatch Logs at $0.63/GB ingested in Frankfurt.
  - Custom metrics at $0.30 each.
  - Alarms at $0.10 each.
  - Secrets Manager at $0.40 per secret, if used.

### Lightsail, briefly
| | Lightsail 2 GB bundle | EC2 t4g.small setup |
|---|---|---|
| Price | **$12/mo** (60 GB SSD, 3 TB transfer, IPv4 included) | about $21.6 list / $7.6 with the trial |
| IAM | **No instance roles.** You need IAM-user access keys for S3, SSM and ECR | Instance profile with temporary credentials |
| IaC and networking | Only L1 `CfnInstance` in CDK. Firewall is CIDR-only, so no CloudFront prefix list. No DLM or VPC endpoints | Full CDK L2 support, SG prefix lists, DLM, gateway endpoint |

Verdict: Lightsail is cheaper and simpler, but it goes against the "no long-lived keys, everything in IaC" story. EC2 costs about $10/month more after 2026, and that buys a much stronger interview narrative.

---

## 2. Networking and TLS

### Option (a): Caddy + LE at `api.smartdoc.codemit.sk`, SPA on CloudFront
- Pros:
  - Simplest setup.
  - No CloudFront timeouts on the API path.
- Cons:
  - Two origins, so you need CORS, with a preflight on every `Authorization` request (cached with `Access-Control-Max-Age`).
  - EC2 is exposed to the whole internet with no WAF or DDoS layer, so rate limiting has to live in the app.

### Option (b), recommended: one CloudFront distribution with `/api/*` going to EC2
- Pros:
  - Same-origin, so no CORS.
  - One public hostname.
  - WAF (managed rules plus an IP rate-limit rule) in front of the API.
  - EC2 accepts only CloudFront traffic.
  - The flat-rate Free plan makes all of this $0.
- Costs:
  - The response timeout has to be designed around (see the SSE section below).
  - Three extra gotchas, listed below.

**Does SSE stream through CloudFront? Yes. What the docs say:**
- The origin **response timeout** covers two things: the wait for the first byte, **and** the gap *between packets* of a response. The default is 30 s. The range is 1–60 s, and up to 180 s via a quota request, which is a hard maximum.
- **Response completion timeout** is optional. **"If you don't set a value … CloudFront doesn't enforce a maximum."** A long stream is fine as long as bytes keep flowing.
- For POST, CloudFront drops the connection on a read timeout and **does not retry**.
- Checklist:
  - `/api/*` uses `CachePolicy.CACHING_DISABLED`. That also means no edge compression, which would otherwise buffer the stream.
  - Heartbeat `: ping\n\n` every 15 s.
  - `readTimeout: 60s`.
  - Headers `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`.
  - Send the first event immediately. Sending the retrieved citations first also helps UX.
  - Leave out `encode` on the SSE route in Caddy and skip compression middleware in NestJS. Caddy already flushes `text/event-stream` immediately, whatever `flush_interval` says.
  - Smoke test: `curl -N -X POST https://smartdoc.codemit.sk/api/chat/...`.
- `EventSource` only supports GET. For POST, the frontend reads the stream with `fetch` + `ReadableStream`, or `@microsoft/fetch-event-source`.

**Authorization header:** you can't list `Authorization` on its own in an origin request policy. **With caching disabled, the managed `AllViewerExceptHostHeader` policy forwards it.** Not forwarding `Host` means CloudFront sends `Host: origin.smartdoc.codemit.sk`, which matches the Caddy site and its cert.

**Gotcha 1, SPA routing.** `errorResponses` (403/404 → `/index.html`) applies to the **whole distribution**. It would turn API 401/403/404 responses into a 200 HTML page, and the frontend's JSON parse would break. Use a **CloudFront Function** on the default behavior only:
```js
function handler(e){var r=e.request; if(r.uri.indexOf('.')===-1) r.uri='/index.html'; return r;}
```

**Gotcha 2, SG quota.** The managed prefix list `com.amazonaws.global.cloudfront.origin-facing` **counts as 55 rules** against the default quota of 60 per SG. So allow **only 443** from it. Look it up with `ec2.PrefixList.fromLookup({ prefixListName: 'com.amazonaws.global.cloudfront.origin-facing' })`.

**Gotcha 3, "any CloudFront" is not "my CloudFront".** Anyone's distribution can reach an origin that only filters on the prefix list. So add a custom origin header `X-Origin-Verify: <secret>`, and have Caddy return 403 when it's missing. VPC origins would solve this properly, but they aren't in the Free plan (Business and up), and they need a private subnet, which would mean a NAT gateway for OpenAI egress.

**Origin certificate:** DNS `origin.smartdoc.codemit.sk` has an A record pointing at the EIP. Caddy uses the ACME **HTTP-01** challenge, so port **80 is open to 0.0.0.0/0** and serves only the challenge or a redirect. Port 443 accepts only the CloudFront prefix list. The upgrade path is DNS-01: a custom Caddy build with `caddy-dns/route53`, `route53:ChangeResourceRecordSets` on the instance role, and port 80 closed entirely.

```caddy
{ email admin@codemit.sk }
origin.smartdoc.codemit.sk {
  @cf header X-Origin-Verify {$ORIGIN_VERIFY_SECRET}
  handle @cf { reverse_proxy api:3000 }
  respond 403
  log { output stdout
        format json }
}
```

**ACM:** the CloudFront cert **must be in us-east-1**, and so must a Cognito custom-domain cert and the CLOUDFRONT-scope WAF web ACL. Put all edge resources in one **us-east-1 `EdgeStack`**. The EC2 origin is just a DNS string, so this needs no `crossRegionReferences`.

**Flat-rate Free plan constraints (verified):**
- 1M requests and 100 GB per month, plus a 5 GB S3 credit.
- **5 cache behaviors.** We use 2.
- **Managed** origin-request and response-header policies only. That's fine: `AllViewerExceptHostHeader` and `SECURITY_HEADERS` are both managed.
- A **WAF web ACL is required**. WAF rule groups aren't allowed, but individual rules and AWS managed rules are.
- At most 3 Free plans per account.
- If you exceed the allowances, you get a throttled service, never overage charges.
- Since 2026-09-03 you can subscribe via **CloudFormation `AWS::PricingPlanManager::Subscription`**, passing the distribution ARN and the web ACL ARN, optionally with the Route 53 zone ARN. Free subscriptions activate immediately.
- WAF nuance: `AWSManagedRulesCommonRuleSet` → `SizeRestrictions_BODY` blocks bodies over 8 KB. Send only the new message (history lives on the server), or set that rule to COUNT for `/api/chat*`. Uploads go straight to S3, so they never pass through WAF.

---

## 3. Cognito (invite-only)

**Pricing (verified):**

| Tier | Price | Free allowance |
|---|---|---|
| Lite | $0.0055/MAU | 10k MAU/month, always free (not tied to the 12 months) |
| **Essentials** (the default) | $0.015/MAU | 10k MAU/month, always free |
| Plus | $0.02/MAU | none |

- **Managed login needs Essentials or Plus.** Lite only has the classic Hosted UI.
- Access-token customization (pre-token-generation V2) also needs Essentials or Plus.
- The default Cognito email sender allows **50 emails per day**. That's plenty for invites. Switch to SES only if it isn't.

```ts
const pool = new cognito.UserPool(this, 'Users', {
  featurePlan: cognito.FeaturePlan.ESSENTIALS,
  selfSignUpEnabled: false,
  signInAliases: { email: true }, autoVerify: { email: true },
  standardAttributes: { email: { required: true, mutable: false } },
  userInvitation: {
    emailSubject: 'Your SmartDoc AI invite',
    emailBody: 'Hi {username}, temporary password: {####}. Sign in at https://smartdoc.codemit.sk',
  },
  passwordPolicy: { minLength: 12, tempPasswordValidity: Duration.days(7) },
  mfa: cognito.Mfa.OPTIONAL, mfaSecondFactor: { otp: true, sms: false },
  accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
  deletionProtection: true, removalPolicy: RemovalPolicy.RETAIN,
});
pool.addDomain('Domain', {
  cognitoDomain: { domainPrefix: `smartdoc-${stage}-codemit` },
  managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
});
const web = pool.addClient('Web', {
  generateSecret: false,                          // public SPA client → PKCE
  oAuth: { flows: { authorizationCodeGrant: true },
           scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
           callbackUrls: ['https://smartdoc.codemit.sk/auth/callback'],
           logoutUrls: ['https://smartdoc.codemit.sk/'] },
  supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
  preventUserExistenceErrors: true,
  accessTokenValidity: Duration.hours(1), refreshTokenValidity: Duration.days(7),
});
// Newer managed login shows no styled page without a branding style:
new cognito.CfnManagedLoginBranding(this, 'Branding', {
  userPoolId: pool.userPoolId, clientId: web.userPoolClientId, useCognitoProvidedValues: true });
```

- **Invite:** `aws cognito-idp admin-create-user --username a@x.sk --user-attributes Name=email,Value=a@x.sk Name=email_verified,Value=true --desired-delivery-mediums EMAIL`. Managed login handles `NEW_PASSWORD_REQUIRED` on first sign-in. A stretch goal is an admin-only NestJS endpoint that calls `AdminCreateUser`, gated on the `cognito:groups` claim containing `admin`.
- **Dev:** a separate `dev` user pool, instantiated per stage, with `localhost:5173` callbacks. Localhost callbacks never go on the prod client.
- **Domain:** start with the prefix domain. A custom `auth.smartdoc.codemit.sk` needs a us-east-1 cert, and **its parent must resolve to an A record**. The CloudFront alias on `smartdoc.codemit.sk` satisfies that, so deploy `EdgeStack` first.

**SPA client options:**

| Option | Verdict |
|---|---|
| **Managed login + `react-oidc-context`/`oidc-client-ts` (auth code + PKCE)** | **Pick this.** No UI code, and the invite, MFA and forgot-password flows are handled. It's standards-based, so you could swap the IdP later. |
| Amplify Auth + Authenticator UI (SRP in the app) | Works, and it handles challenges too. It pulls in `aws-amplify`, is heavier, and ties you to AWS. |
| Custom SRP form | You would implement the NEW_PASSWORD_REQUIRED, MFA and reset challenges yourself. Wasted time on a weekend build. |

Token storage trade-off: by default `oidc-client-ts` keeps tokens in sessionStorage, which is exposed to XSS. The strict answer is a BFF with httpOnly cookies. Mention it as future work.

**NestJS verification** (`aws-jwt-verify` v5.x; npm shows 5.2.0 [UNVERIFIED exact latest]):
```ts
const verifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: 'access', clientId });
await verifier.hydrate();                     // prefetch JWKS at boot; cached afterwards
const p = await verifier.verify(bearer);      // throws on bad sig/exp/client_id/token_use
req.user = { id: p.sub, groups: p['cognito:groups'] ?? [] };   // key ALL data by sub, never email
```
- Send the **access token** to the API. It's the OAuth2 token meant for resource servers and carries `client_id`, `scope` and groups. The ID token is for the client to know who signed in.
- The access token has no `email`. If the backend needs it, persist it on the first `/me` call from `/oauth2/userInfo`, or add it through pre-token-generation V2.
- The Python service doesn't verify JWTs. It is reachable only on the compose network, and NestJS passes `X-User-Id` plus an internal shared secret.

---

## 4. S3

**Docs bucket (eu-central-1, GDPR story):**
- `BlockPublicAccess.BLOCK_ALL`, `enforceSSL`, `S3_MANAGED` encryption, versioning on, `RemovalPolicy.RETAIN`.
- **Key:** built by the server as `users/{sub}/documents/{docId}/original.pdf`. The original filename lives only in the DB, which prevents traversal and collisions. Deleting everything a user owns is one prefix delete, which covers GDPR erasure.
- **Lifecycle:** abort incomplete multipart uploads after 1 day. Expire noncurrent versions after 30 days. A nightly job removes objects whose DB row is still `pending` after 24 h.
- **CORS:** `AllowedOrigins: [https://smartdoc.codemit.sk, http://localhost:5173 (dev bucket only)]`, `AllowedMethods: [POST, GET]`, `AllowedHeaders: [*]`, `MaxAge: 3000`.

**Upload flow and why POST:**
- A presigned PUT **can't enforce size**. The SDK doesn't sign `Content-Length` in a way S3 enforces.
- A presigned POST policy can, through `content-length-range`.

```ts
const { url, fields } = await createPresignedPost(s3, {       // @aws-sdk/s3-presigned-post
  Bucket: DOCS_BUCKET, Key: `users/${sub}/documents/${docId}/original.pdf`,  // exact key → policy condition
  Conditions: [['content-length-range', 1, 20 * 1024 * 1024], ['eq', '$Content-Type', 'application/pdf']],
  Fields: { 'Content-Type': 'application/pdf' }, Expires: 300,
});
```
1. `POST /api/documents` creates a row with `status=pending` and returns `{url, fields}`.
2. The browser uploads straight to S3, bypassing CloudFront and WAF.
3. `POST /api/documents/:id/complete`: NestJS calls `HeadObject` to check size and type, **checks the `%PDF-` magic bytes** (the client declared the Content-Type, so it can't be trusted), then enqueues ingestion.
4. The Python service reads the object using the instance role.

The upgrade path is an S3 event → SQS queue → worker.

**IAM (instance role, no static keys):**
- Docs bucket: `s3:GetObject`, `PutObject` (needed to sign the POST) and `DeleteObject` on `arn:…:docs/users/*`, plus `ListBucket` with an `s3:prefix` condition of `users/`.
- Backups bucket: `PutObject` **only, no delete**.
- Per-user isolation is enforced in the app, from the JWT `sub`. Enforcing it in IAM would need Cognito Identity Pools with `${cognito-identity.amazonaws.com:sub}` policy variables, which is overkill here.
- A presigned request stops working when the signing credentials expire. Instance-role credentials rotate every few hours, which is fine with 5-minute URLs.

**Local dev: use a real dev bucket.**
- **MinIO CE** stopped publishing images in October 2025, went into maintenance in December 2025, and was **archived on 2026-02-12**. That rules it out.
- **LocalStack** has **required `LOCALSTACK_AUTH_TOKEN` since 2026.03**. The free Hobby plan is for non-commercial use only, and Cognito emulation is paid.
- So: a `SmartDoc-Dev-Storage` bucket plus a dev user pool, costing about $0, with the real IAM, CORS and POST-policy behavior.
- Credentials come from **IAM Identity Center** (`aws sso login --profile smartdoc-dev`). Compose mounts `~/.aws:ro` and sets `AWS_PROFILE`. There are still no static keys.

---

## 5. Secrets

| | SSM Parameter Store SecureString (standard) | Secrets Manager |
|---|---|---|
| Cost | **$0** (standard parameters, standard throughput, `aws/ssm` AWS-managed key) | $0.40/secret/mo + $0.05 per 10k calls |
| Rotation | manual | native (Lambda) |
| Created by CFN/CDK | **No.** `AWS::SSM::Parameter` supports only String and StringList | Yes (`generateSecretString`) |

**Pick SSM.**
- Secrets such as `/smartdoc/prod/openai/api_key`, `/db/password` and `/origin_verify_secret` are created once with `aws ssm put-parameter --type SecureString` and documented in `docs/runbooks/bootstrap-secrets.md`.
- Non-secret config (the Cognito IDs, the bucket name) goes in String parameters written by CDK.
- The instance role gets `ssm:GetParametersByPath` on `/smartdoc/prod/*`.

**How containers receive secrets:**
1. `deploy.sh`, run via SSM Run Command, calls `aws ssm get-parameters-by-path --path /smartdoc/prod --recursive --with-decryption`.
2. It renders `/opt/smartdoc/.env` (mode 0600, root) for plain config.
3. It writes the OpenAI key and DB password to **compose `secrets:` files**, mounted at `/run/secrets/*`, so they don't appear in `docker inspect` env output.

Containers need no AWS permission to read secrets. The alternative, where the app fetches parameters at boot through the SDK, works only because AL2023 sets the IMDS **hop limit to 2**. It adds AWS coupling to the app code.

---

## 6. Deploy pipeline

- **Images:** `runs-on: ubuntu-24.04-arm`. Since **2026-01-29** these are free-minute-eligible in private repos too (2 vCPU private, 4 vCPU public), so builds are native arm64 with no QEMU.
- Use `docker/build-push-action` with `platforms: linux/arm64`, `cache-from/to: type=gha`, and tag `${{ github.sha }}`.
- ECR repos `smartdoc/api` and `smartdoc/ai`: `imageTagMutability: IMMUTABLE`, scan on push, lifecycle keeps the last 10 images. Caddy uses the official multi-arch image.
- **Auth:** `aws-actions/configure-aws-credentials@v6` (v6.3.0, 2026-09-11) with `role-to-assume`. Job permissions: `id-token: write`.

```ts
const gh = new iam.OidcProviderNative(this, 'GitHub', {
  url: 'https://token.actions.githubusercontent.com', clientIds: ['sts.amazonaws.com'] });
const deploy = new iam.Role(this, 'GhDeploy', {
  assumedBy: new iam.WebIdentityPrincipal(gh.oidcProviderArn, { StringEquals: {
    'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
    'token.actions.githubusercontent.com:sub': 'repo:<owner>/smartdoc-ai:environment:production' } }),
  maxSessionDuration: Duration.hours(1) });
```
`OidcProviderNative` uses the native `AWS::IAM::OIDCProvider` resource. The older `OpenIdConnectProvider` is Lambda-backed.

The deploy role gets:
- ECR push on the two repos.
- `s3:PutObject` on `artifacts/releases/*`.
- `ssm:SendCommand` on the instance ARN (tag condition) and `arn:aws:ssm:eu-central-1::document/AWS-RunShellScript`.
- `ssm:GetCommandInvocation`.
- `s3 sync` on the SPA bucket and `cloudfront:CreateInvalidation`.

An optional read-only `GhCdkDiff` role can assume `cdk-hnb659fds-lookup-role` to run `cdk diff` on PRs. Run `cdk deploy` locally at first.

**Backend deploy job:**
1. Build and push both images.
2. `aws s3 cp deploy/ s3://…-artifacts/releases/$SHA/ --recursive`, which uploads `compose.prod.yml` and the `Caddyfile`.
3. `aws ssm send-command --targets Key=tag:app,Values=smartdoc --document-name AWS-RunShellScript --parameters 'commands=["/opt/smartdoc/bin/deploy.sh '$SHA'"]'`.
4. Poll `get-command-invocation`.
5. `curl -fsS https://smartdoc.codemit.sk/api/health`.

```bash
# deploy.sh <sha> (on host)
set -euo pipefail; cd /opt/smartdoc
aws s3 cp s3://$ARTIFACTS/releases/$1/ ./ --recursive
./render-env.sh                                   # SSM → .env + secrets/
export TAG=$1
docker compose pull
docker compose exec -T db pg_dump -Fc -U app smartdoc | aws s3 cp - s3://$BACKUPS/pre-deploy/$1.dump
docker compose run --rm api node dist/db/migrate.js      # Drizzle migrations
docker compose up -d --remove-orphans --wait             # fails if healthchecks fail
docker image prune -af --filter "until=168h"
```
To roll back, rerun the script with the previous SHA. Downtime is a few seconds while the API restarts, which is acceptable here.

The host logs in to ECR through `amazon-ecr-credential-helper` (available via dnf on AL2023). The **compose plugin isn't in AL2023's repos**, so install the binary into `/usr/local/lib/docker/cli-plugins` from user data.

**Frontend:** CI builds with `VITE_*` values read from SSM String parameters. Then:
- `aws s3 sync dist/ s3://spa --delete --exclude index.html --cache-control "public,max-age=31536000,immutable"`
- `aws s3 cp dist/index.html s3://spa/ --cache-control "no-cache"`
- `aws cloudfront create-invalidation --paths /index.html`

The first 1,000 invalidation paths per month are free. **`BucketDeployment` was rejected** because it ties SPA releases to `cdk deploy`, runs a Lambda with an AWS CLI layer (memory limits on big bundles), and is slower.

---

## 7. Ops and hardening

**Data and backups:**
- **Data volume:** `ec2.Volume` (10 GiB gp3, encrypted, same AZ as the instance, `RemovalPolicy.SNAPSHOT`, tag `Backup=daily`), attached with `CfnVolumeAttachment` as `/dev/sdf`.
- On Nitro it appears as `nvme1n1`. User data runs `mkfs.xfs` only if `blkid` finds nothing, then mounts `/data` by UUID with `nofail`.
- Postgres 18 image gotcha: **PGDATA is now `/var/lib/postgresql/18/docker` and the volume is `/var/lib/postgresql`**. Mount `/data/postgres:/var/lib/postgresql`, not `…/data`. Image: `pgvector/pgvector:0.8.x-pg18`, multi-arch.
- **Backups, two layers:**
  1. **DLM** `CfnLifecyclePolicy`: daily at 03:00 UTC, keep 7. DLM itself is free; you pay only for snapshot storage. These snapshots are crash-consistent, like a power loss that Postgres recovers from with WAL replay.
  2. A **nightly `pg_dump -Fc` to the backups bucket**, via a **systemd timer**. AL2023 doesn't ship cron. Lifecycle expires dumps after 35 days.
- Write `docs/runbooks/restore.md` and test the restore once. The interview line: "an untested backup is not a backup".

**Logs, metrics, alarms:**
- **Logs:** the compose `awslogs` driver (`mode: non-blocking`, `max-buffer-size: 4m`) sends to `/smartdoc/prod/{caddy,api,ai,db}` with 14-day retention. Log structured JSON (pino in NestJS, structlog in Python) so Logs Insights can compute cost per query, p95 latency and cache hit rate.
- **CloudWatch agent:** only `mem_used_percent` and `disk_used_percent`, which is 2 custom metrics, inside the free 10.
- **Alarms** (≤10 are free) go to an SNS email topic:
  - `StatusCheckFailed_Instance` triggers a reboot action. Hardware failures are covered separately, because **simplified automatic recovery is on by default for t4g**.
  - `CPUCreditBalance < 30`
  - memory > 90%
  - disk > 80%
  - 5xx metric filter on the Caddy logs
  - an app-emitted `OpenAICostUSD` daily sum
  - the Route 53 health check on `/api/health`. Its metric exists **only in us-east-1**, so that alarm and its SNS topic live in `EdgeStack`.
- **Budgets:** `CfnBudget` at $25/month, alerting at 80% actual and 100% forecast. Non-action budgets are free. Add `CfnAnomalyMonitor` (free) and a hard monthly budget on the OpenAI project key.

**Hardening:**
- **No SSH:** no key pair and no port 22. Access is through **SSM Session Manager** (`ssmSessionPermissions: true`).
- **IMDSv2 required, hop limit 2** (`requireImdsv2: true, httpPutResponseHopLimit: 2`). The AL2023 AMI already defaults to this; pin it explicitly anyway.
- **SG inbound:** 443 from the CloudFront prefix list, 80 from anywhere (ACME only). Outbound is open (OpenAI, ECR, SSM).
- Postgres and the AI service are never published outside the compose network.
- EBS encrypted. S3 has BPA and `enforceSSL`, and the SPA uses OAC.
- CloudFront: TLS 1.2 (2021 policy) minimum, HTTP/2 and HTTP/3, the managed `SECURITY_HEADERS` policy, and WAF with the managed Common, KnownBadInputs and IpReputation rules plus a rate-based rule on `/api/*` (e.g. 300 requests per 5 min per IP).
- `dnf-automatic` security updates or SSM Patch Manager (free on EC2).
- Containers run as non-root, with a read-only root FS where possible.
- **Pin the AMI:** use `latestAmazonLinux2023({ cpuType: ARM_64, cachedInContext: true })`. Otherwise a new AMI release **replaces the instance** on the next deploy.
- Set `userDataCausesReplacement: false`.
- Run `cdk-nag` (AwsSolutions) in `cdk synth`.

---

## 8. CDK stack split

Use aws-cdk-lib 2.x (2.270.0 is current). Run `cdk bootstrap aws://ACCT/eu-central-1 aws://ACCT/us-east-1`. Set `env` explicitly on every stack so `fromLookup` works.

| Stack | Region | Key constructs | Depends on |
|---|---|---|---|
| `SmartDoc-Ci` | eu-central-1 | `iam.OidcProviderNative`, `GhDeploy` role, optional `GhCdkDiff` role | |
| `SmartDoc-{Dev,Prod}-Storage` (termination protection) | eu-central-1 | docs bucket (CORS, lifecycle, versioning), backups bucket, artifacts bucket, ECR repos | |
| `SmartDoc-{Dev,Prod}-Auth` | eu-central-1 | `UserPool` (Essentials, no sign-up), `UserPoolDomain` (newer managed login), `UserPoolClient` (PKCE), `CfnManagedLoginBranding`, SSM String parameters for the IDs | |
| `SmartDoc-Prod-Compute` | eu-central-1 | `Vpc` (public subnets only, `natGateways: 0`, `maxAzs: 2`, S3 gateway endpoint), SG + `PrefixList.fromLookup`, role, `ec2.Instance`, data `Volume` + attachment, `CfnEIP` + association, Route 53 `A origin.smartdoc` → EIP, `dlm.CfnLifecyclePolicy`, `LogGroup`s, alarms + SNS, `budgets.CfnBudget`, `ce.CfnAnomalyMonitor` | Storage, Auth (ARNs and names) |
| `SmartDoc-Prod-Edge` | **us-east-1** | ACM `Certificate` (DNS-validated, `HostedZone.fromLookup('codemit.sk')`), `wafv2.CfnWebACL` (CLOUDFRONT scope), SPA bucket, `cloudfront.Function` (SPA rewrite), `Distribution` (S3 OAC default behavior + `HttpOrigin('origin.smartdoc.codemit.sk')` for `/api/*`), A/AAAA alias records, `AWS::PricingPlanManager::Subscription` (Free), Route 53 health check + alarm | the origin DNS name as a string, so no cross-region references |

The core of the `/api/*` behavior:
```ts
'/api/*': {
  origin: new origins.HttpOrigin('origin.smartdoc.codemit.sk', {
    protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    readTimeout: Duration.seconds(60), keepaliveTimeout: Duration.seconds(60),
    customHeaders: { 'X-Origin-Verify': originSecret } }),
  viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
  allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
  cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
  originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
},  // and NO distribution-level errorResponses
```

The dev stage deploys only Storage and Auth; locally the app runs on Docker Compose. Deploy order: Ci → Storage → Auth → Compute → Edge.

---

## Interview talking points
- The infrastructure runs about **$21.6/month at list price, about $7.6 until 2026-12-31**. The biggest fixed line after compute is the $3.65 IPv4 charge. I sized compute from measurements and can resize with one CDK line.
- The whole path is keyless: GitHub OIDC for CI, the instance role on EC2, SSO for local dev, and SSM SecureString for secrets.
- There is one origin per user-facing domain. WAF and DDoS protection sit in front of the API. EC2 accepts traffic only from CloudFront, and a secret header blocks other people's distributions.
- I know the CloudFront gotchas: timeouts are measured per packet (so heartbeats keep SSE alive), custom error responses apply distribution-wide, the Authorization header only forwards with all viewer headers, and the prefix list weighs 55 SG rules.
- The database lives on its own EBS volume, with DLM snapshots, a logical dump every night and before each deploy, and a restore runbook that has been tested.

## Unverified or to check before building
- Whether your account can use the CloudFront flat-rate Free plan. Accounts "using AWS Free Tier" are ineligible. A pre-July-2025 account past its 12 months should qualify. Check the CloudFront console.
- Whether your aws-cdk-lib version already has an L1 for `AWS::PricingPlanManager::Subscription`. If not, use `CfnResource`. Also whether the subscription must be created in us-east-1.
- Whether a Route 53 health check on a CloudFront hostname counts as an "AWS endpoint" (free) or costs $0.75/month.
- The RAM figures are estimates. Measure them.
- The exact latest `aws-jwt-verify` version (5.1.x vs 5.2.0).
- Whether `OidcProviderNative` still needs `thumbprints` in your CDK version.
- WAF PAYG prices ($5 per ACL, $1 per rule, $0.60 per million requests) were not re-verified.

## Sources
- [AWS Free Tier $200 credits / 6-month Free plan (What's New, Jul 2025)](https://aws.amazon.com/about-aws/whats-new/2025/07/aws-free-tier-credits-month-free-plan/) · [Pre-July-2025 accounts unaffected (Rackspace summary)](https://spot.rackspace.com/blog/aws-free-tier)
- [T4g free trial extended to 2026-12-31 (re:Post)](https://repost.aws/articles/ARi_gf6vo6TuqNtMQdiYPKyA/announcing-amazon-ec2-t4g-free-trial-extension) · [EC2 FAQs](https://aws.amazon.com/ec2/faqs/)
- [EC2 On-Demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/) and AWS public price-list JSON (`b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/…/EU (Frankfurt)/Linux`, `…/ebs.json`, `…/cloudwatch/…/cloudwatch.json`, published 2026-09-22/24)
- [VPC pricing: public IPv4 $0.005/h, gateway endpoints free](https://aws.amazon.com/vpc/pricing/)
- [CloudFront flat-rate pricing plans (docs)](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html) · [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/) · [Flat-rate API/CFN support (Sep 2026)](https://aws.amazon.com/about-aws/whats-new/2026/09/cloudfront-flat-rate-pricing-plans-api/) · [AWS::PricingPlanManager::Subscription](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-pricingplanmanager-subscription.html)
- [CloudFront origin settings: response timeout per packet, completion timeout](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html) · [Increase origin response timeout (re:Post)](https://repost.aws/knowledge-center/cloudfront-custom-origin-response)
- [Forward Authorization header via CloudFront (re:Post)](https://repost.aws/knowledge-center/cloudfront-authorization-header)
- [Custom error responses rewrite API errors distribution-wide (aws-samples issue)](https://github.com/aws-samples/sample-collaborative-ai-dlc/issues/186)
- [CloudFront managed prefix list = 55 SG rules (AWS blog)](https://aws.amazon.com/blogs/networking-and-content-delivery/limit-access-to-your-origins-using-the-aws-managed-prefix-list-for-amazon-cloudfront) · [CDK PrefixList.fromLookup](https://docs.aws.amazon.com/cdk/api/v2/java/software/amazon/awscdk/services/ec2/PrefixListLookupOptions.html)
- [Caddy reverse_proxy (flush for text/event-stream)](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [Cognito pricing (Lite/Essentials/Plus, 10k MAU free)](https://aws.amazon.com/cognito/pricing/) · [CDK Cognito README](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cognito-readme.html) · [ManagedLoginBranding (CFN)](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-managedloginbranding.html) · [Cognito quotas (50 emails/day)](https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html) · [Pre-token-generation V2 (Essentials/Plus)](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-token-generation.html) · [Cognito custom domain (parent A record)](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-add-custom-domain.html)
- [aws-jwt-verify (npm)](https://www.npmjs.com/package/aws-jwt-verify) · [awslabs/aws-jwt-verify](https://github.com/awslabs/aws-jwt-verify) · [react-oidc-context](https://github.com/authts/react-oidc-context)
- [S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) · [Presigned PUT can't limit size (aws-sdk-js #1252)](https://github.com/aws/aws-sdk-js/issues/1252)
- [MinIO CE archived (VONNG)](https://blog.vonng.com/en/db/minio-is-dead/) · [MinIO OSS dead (ragflow issue)](https://github.com/infiniflow/ragflow/issues/13840) · [LocalStack: road ahead / auth token](https://blog.localstack.cloud/the-road-ahead-for-localstack/) · [LocalStack 2026.03.0](https://blog.localstack.cloud/localstack-for-aws-release-2026-03-0/)
- [Systems Manager pricing](https://aws.amazon.com/systems-manager/pricing/) · [Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/) · [CFN SecureString unsupported (roadmap #82)](https://github.com/aws-cloudformation/cloudformation-coverage-roadmap/issues/82)
- [arm64 standard runners in private repos (GitHub, 2026-01-29)](https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories/) · [OidcProviderNative PR](https://github.com/aws/aws-cdk/pull/28634) · [CDK GitHub OIDC guide](https://towardsthecloud.com/blog/aws-cdk-openid-connect-github) · [configure-aws-credentials releases](https://github.com/aws-actions/configure-aws-credentials/releases)
- [CloudFront invalidation pricing](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PayingForInvalidation.html) · [ECR pricing](https://aws.amazon.com/ecr/pricing/) · [DLM (EBS docs)](https://docs.aws.amazon.com/ebs/latest/userguide/snapshot-lifecycle.html) · [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/) · [AWS Budgets pricing](https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/) · [Route 53 pricing](https://aws.amazon.com/route53/pricing/) · [100 GB free egress (AWS blog)](https://aws.amazon.com/blogs/aws/aws-free-tier-data-transfer-expansion-100-gb-from-regions-and-1-tb-from-amazon-cloudfront-per-month)
- [AL2023 IMDSv2 defaults (hop limit 2)](https://docs.aws.amazon.com/linux/al2023/ug/imdsv2.html) · [AL2023: systemd timers replace cron](https://docs.aws.amazon.com/linux/al2023/ug/cron.html) · [Docker Compose on AL2023](https://christierney.com/2025/07/17/installing-docker-w-compose-on-amazon-linux-2023/) · [CDK InstanceProps](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.InstanceProps.html) · [EC2 simplified automatic recovery](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-configuration-recovery.html)
- [Lightsail pricing](https://aws.amazon.com/lightsail/pricing/) · [Lightsail has no IAM role (re:Post)](https://repost.aws/questions/QUMbXYXqiKTQ6L2Q2Z_FNLGQ/i-want-to-use-lightsail-to-but-it-doesn-t-seem-to-allow-uploads-to-s3-buckets)
- [Postgres official image (PG18 PGDATA change)](https://hub.docker.com/_/postgres) · [pgvector/pgvector image](https://hub.docker.com/r/pgvector/pgvector) · [FlashRank](https://github.com/PrithivirajDamodaran/FlashRank) · [aws-cdk-lib (npm)](https://www.npmjs.com/package/aws-cdk-lib)
