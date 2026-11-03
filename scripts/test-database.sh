#!/usr/bin/env bash
# Sourced by `just test-int` and `just test-e2e`. The harness needs two URLs to the
# same test database (0.4.2): DATABASE_URL_TEST as the runtime role, which the
# tests and the app connect as, and MIGRATION_DATABASE_URL_TEST as the migrator,
# which creates, migrates and drops each run's schema. Inside the umbrella,
# derive them from the local stack's settings when they are unset.
if { [ -z "${DATABASE_URL_TEST:-}" ] || [ -z "${MIGRATION_DATABASE_URL_TEST:-}" ]; } && [ -f ../infra/.env ]; then
  # The last assignment wins, as in Compose; one pair of surrounding quotes is not part of the value.
  setting() { sed -n "s/^$1=//p" ../infra/.env | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"; }
  # Percent-encoded: a password may hold characters that end a URL's userinfo (@ : / # %).
  encoded() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
  app_password=$(setting SADARA_APP_PASSWORD)
  migrator_password=$(setting SADARA_MIGRATOR_PASSWORD)
  if [ -z "$app_password" ] || [ -z "$migrator_password" ]; then
    echo "../infra/.env has no SADARA_APP_PASSWORD or SADARA_MIGRATOR_PASSWORD (the database roles, 0.4.2)." >&2
    echo "Run \`just up\` in the umbrella: it adds them, and the stack creates the roles." >&2
    exit 1
  fi
  port=$(setting POSTGRES_PORT)
  : "${DATABASE_URL_TEST:=postgresql://sadara_app:$(encoded "$app_password")@127.0.0.1:${port:-5432}/sadara_test}"
  : "${MIGRATION_DATABASE_URL_TEST:=postgresql://sadara_migrator:$(encoded "$migrator_password")@127.0.0.1:${port:-5432}/sadara_test}"
  export DATABASE_URL_TEST MIGRATION_DATABASE_URL_TEST
fi
if [ -z "${DATABASE_URL_TEST:-}" ] || [ -z "${MIGRATION_DATABASE_URL_TEST:-}" ]; then
  echo "DATABASE_URL_TEST and MIGRATION_DATABASE_URL_TEST are not both set, and ../infra/.env (the umbrella's local stack) was not found." >&2
  echo "Run \`just up\` in the umbrella, or export both yourself: the test database as sadara_app, and as sadara_migrator." >&2
  exit 1
fi
