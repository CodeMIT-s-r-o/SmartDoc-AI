#!/usr/bin/env bash
# Prints a managed-login authorize URL (auth code + PKCE) for the dev client, to test sign-in
# before the SPA handles the callback (Block 1.4). The code verifier is discarded: the goal is
# only to reach http://localhost:5173/auth/callback?code=... after signing in.
set -euo pipefail

env_file=${1:-.env.dev-aws}
[[ -f $env_file ]] || { echo "Missing $env_file. Run: make dev-config" >&2; exit 1; }
# shellcheck disable=SC1090
source "$env_file"

verifier=$(openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-64)
challenge=$(printf '%s' "$verifier" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=')
redirect=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$VITE_OIDC_REDIRECT_URI")

echo "${VITE_COGNITO_DOMAIN}/oauth2/authorize?client_id=${VITE_OIDC_CLIENT_ID}&response_type=code&scope=openid+email&redirect_uri=${redirect}&code_challenge=${challenge}&code_challenge_method=S256"
