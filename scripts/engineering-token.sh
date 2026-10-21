#!/usr/bin/env bash
# Print a GitHub token for the engineering app: the GitHub App the maintainer
# owns, which opens the pull requests prepared for the maintainer so that the
# maintainer can approve them (GitHub refuses an approval from a pull
# request's own author). The token is scoped to one repository and expires
# within the hour.
#
# The app's id and private key live outside every repository, in
# ${SADARA_ENGINEERING_APP_DIR:-~/.config/sadara/engineering-app}; the
# umbrella's `just engineering-app` creates them. The key is read, never printed.
#
#   ./scripts/engineering-token.sh <owner/repo>     exit 3: no engineering app configured
set -euo pipefail

repo=${1:?usage: engineering-token.sh <owner/repo>}
dir=${SADARA_ENGINEERING_APP_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/sadara/engineering-app}
if ! [ -f "$dir/app.json" ] || ! [ -f "$dir/private-key.pem" ]; then
  echo "engineering-token: no engineering app in $dir — run \`just engineering-app\` in the umbrella" >&2
  exit 3
fi
app_id=$(jq -r '.id // empty' "$dir/app.json")
[ -n "$app_id" ] || { echo "engineering-token: $dir/app.json names no app id" >&2; exit 1; }

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
api() { # api <method> <path> [<json body>] — as the app, with the JWT
  curl --fail --silent --show-error --retry 2 -X "$1" \
    -H "Authorization: Bearer $jwt" -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' ${3:+--data "$3"} "https://api.github.com$2"
}

# A ten-minute app JWT (RS256), back-dated a minute for clock skew.
now=$(date +%s)
header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
claims=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now - 60)) $((now + 540)) "$app_id" | b64url)
signature=$(printf '%s.%s' "$header" "$claims" | openssl dgst -sha256 -sign "$dir/private-key.pem" -binary | b64url)
jwt="$header.$claims.$signature"

installation=$(api GET "/repos/$repo/installation" | jq -r '.id') || {
  echo "engineering-token: the engineering app is not installed on $repo — install it (just engineering-app status)" >&2
  exit 1
}
api POST "/app/installations/$installation/access_tokens" "{\"repositories\":[\"${repo#*/}\"]}" |
  jq -r '.token'
