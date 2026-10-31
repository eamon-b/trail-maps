#!/usr/bin/env bash
#
# Write the `[r2]` rclone remote from a Cloudflare API token, on the build box.
#
# An R2-capable API token doubles as S3 credentials: the access key id is the
# token's id and the secret is the SHA-256 of the token value. So one scoped
# token (Account > Workers R2 Storage: Edit, plus Zone > Cache Purge for
# upload-tiles.sh) covers rclone, wrangler and the manifest purge, with no
# separate R2 key pair to create and revoke.
#
# Usage:  contours/scripts/remote/rclone-from-token.sh [token-file]   (default ~/token)
#
# Reads the token from a file the human put on the box (chmod 600); never
# prints it or the derived secret. Revoke the token when the box is destroyed.

set -euo pipefail

TOKEN_FILE="${1:-$HOME/token}"
REMOTE="${RCLONE_REMOTE:-r2}"
BUCKET="${R2_BUCKET:-aus-map-data}"

[ -r "$TOKEN_FILE" ] || { echo "Error: cannot read $TOKEN_FILE" >&2; exit 1; }
chmod 600 "$TOKEN_FILE"
token=$(tr -d '[:space:]' < "$TOKEN_FILE")
api=https://api.cloudflare.com/client/v4

account=$(curl -fsS -H "Authorization: Bearer $token" "$api/accounts" | jq -r '.result[0].id')
[ -n "$account" ] && [ "$account" != null ] || { echo "Error: the token cannot list accounts" >&2; exit 1; }
# Account-owned tokens verify under the account, not /user/tokens/verify.
token_id=$(curl -fsS -H "Authorization: Bearer $token" "$api/accounts/$account/tokens/verify" | jq -r '.result.id')
[ -n "$token_id" ] && [ "$token_id" != null ] || { echo "Error: token verification failed" >&2; exit 1; }
secret=$(printf %s "$token" | sha256sum | cut -d' ' -f1)

mkdir -p ~/.config/rclone
umask 077
conf=~/.config/rclone/rclone.conf
# Replace any existing stanza for this remote, keep the rest.
if [ -f "$conf" ]; then
  awk -v r="[$REMOTE]" '$0 == r {skip=1; next} /^\[/ {skip=0} !skip' "$conf" > "$conf.tmp" && mv "$conf.tmp" "$conf"
fi
cat >> "$conf" <<EOF
[$REMOTE]
type = s3
provider = Cloudflare
access_key_id = $token_id
secret_access_key = $secret
endpoint = https://$account.r2.cloudflarestorage.com
no_check_bucket = true
EOF

rclone lsf --max-depth 1 "$REMOTE:$BUCKET" > /dev/null
echo "rclone remote '$REMOTE' written; it can list $BUCKET."
echo "For upload-tiles.sh: export CLOUDFLARE_API_TOKEN=\$(cat $TOKEN_FILE) CLOUDFLARE_ACCOUNT_ID=$account"
