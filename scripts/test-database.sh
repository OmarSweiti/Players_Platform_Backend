#!/usr/bin/env bash
# Sourced by `just test-int` and `just test-e2e`. The harness needs DATABASE_URL_TEST;
# inside the umbrella, derive it from the local stack's settings when it is unset.
if [ -z "${DATABASE_URL_TEST:-}" ] && [ -f ../infra/.env ]; then
  # The last assignment wins, as in Compose; one pair of surrounding quotes is not part of the value.
  setting() { sed -n "s/^$1=//p" ../infra/.env | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"; }
  # Percent-encoded: a password may hold characters that end a URL's userinfo (@ : / # %).
  password=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$(setting POSTGRES_PASSWORD)")
  port=$(setting POSTGRES_PORT)
  export DATABASE_URL_TEST="postgresql://postgres:${password}@127.0.0.1:${port:-5432}/sadara_test"
fi
if [ -z "${DATABASE_URL_TEST:-}" ]; then
  echo "DATABASE_URL_TEST is not set, and ../infra/.env (the umbrella's local stack) was not found." >&2
  echo "Run \`just up\` in the umbrella, or export DATABASE_URL_TEST yourself." >&2
  exit 1
fi
