#!/usr/bin/env bash
# Install the exact oasdiff release (the breaking-change check, 0.3.9), verified
# by its upstream SHA-256 digest, and print the path of the binary. In CI it
# lands in the runner's temporary directory and joins the PATH; on a laptop it
# is kept in node_modules/.cache, and its archive is verified again every run.
set -euo pipefail

readonly VERSION=1.33.0
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64 | Linux-amd64)
    readonly ASSET=linux_amd64
    readonly SHA256=43a4e328e2d13ba1552d760aa68d2485c75c5621f309f6ff64ae895188345247
    ;;
  Linux-aarch64 | Linux-arm64)
    readonly ASSET=linux_arm64
    readonly SHA256=4ae3c362d6074d919aada2dea82d0ee84366591600384455d0bdc658ddf8f7ae
    ;;
  Darwin-*)
    readonly ASSET=darwin_all
    readonly SHA256=2a479337c15afdcbf0b1e89c0b4d0cf0176472dbc11483358fed1f831d1e46c5
    ;;
  *)
    echo "oasdiff: unsupported platform $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

sha256_of() { # GNU coreutils on Linux; macOS's sha256sum takes other flags
  if sha256sum --version >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}
sha256_check() { [ "$(sha256_of "$2")" = "$1" ]; } # sha256_check <digest> <file>

if [ -n "${RUNNER_TEMP:-}" ]; then
  dir="$RUNNER_TEMP/oasdiff-$VERSION"
else
  dir="$(cd "$(dirname "$0")/.." && pwd)/node_modules/.cache/oasdiff-$VERSION"
fi
mkdir -p "$dir"
archive="$dir/oasdiff_${VERSION}_${ASSET}.tar.gz"
if ! [ -f "$archive" ] || ! sha256_check "$SHA256" "$archive"; then
  curl --fail --location --silent --show-error --retry 3 --retry-all-errors \
    --output "$archive" \
    "https://github.com/oasdiff/oasdiff/releases/download/v${VERSION}/$(basename "$archive")"
  sha256_check "$SHA256" "$archive" || {
    rm -f "$archive"
    echo "oasdiff: the download does not match its published digest" >&2
    exit 1
  }
fi
tar -xzf "$archive" -C "$dir" oasdiff
chmod 0755 "$dir/oasdiff"
if [ -n "${GITHUB_PATH:-}" ]; then printf '%s\n' "$dir" >>"$GITHUB_PATH"; fi
printf '%s\n' "$dir/oasdiff"
