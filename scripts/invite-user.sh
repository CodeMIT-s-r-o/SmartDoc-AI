#!/usr/bin/env bash
# Invites a user to a SmartDoc user pool. Cognito emails a temporary password; the managed login
# page asks for a new one on first sign-in.
# Usage: AWS_PROFILE=codemit scripts/invite-user.sh <email> [--admin]   (STAGE=dev by default)
set -euo pipefail

email=${1:?usage: invite-user.sh <email> [--admin]}
stage=${STAGE:-dev}
region=eu-central-1

pool_id=$(aws ssm get-parameter --region "$region" \
  --name "/smartdoc/${stage}/config/cognito_user_pool_id" --query Parameter.Value --output text)

aws cognito-idp admin-create-user --region "$region" --user-pool-id "$pool_id" \
  --username "$email" \
  --user-attributes Name=email,Value="$email" Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL >/dev/null

if [[ ${2:-} == --admin ]]; then
  aws cognito-idp admin-add-user-to-group --region "$region" --user-pool-id "$pool_id" \
    --username "$email" --group-name admin
fi

echo "Invited ${email} to smartdoc-${stage}$([[ ${2:-} == --admin ]] && echo ' (admin)')"
