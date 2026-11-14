#!/bin/sh
# Checks the licences of an action's installed dependencies against the
# policy of the kit (grant.yaml), with the exceptions the action lists:
#   check.sh <installed dependencies> <action folder> <SBOM to write>
# An exception is a line of <action folder>/licence-exceptions.txt:
#   <package>  # <reason>
# The SBOM (SPDX JSON, by Syft) is kept: it is published with the version.
set -eu

installed=$1 action=$2 sbom=$3
kit=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
config=$(mktemp)
trap 'rm -f "$config"' EXIT

grep -v '^ignore-packages:' "$kit/grant.yaml" > "$config"
echo 'ignore-packages:' >> "$config"
exceptions="$action/licence-exceptions.txt"
if [ -f "$exceptions" ]; then
	while IFS= read -r line || [ -n "$line" ]; do
		case $line in '' | '#'*) continue ;; esac
		package=$(printf '%s' "$line" | sed 's/[[:space:]]*#.*$//')
		reason=$(printf '%s' "$line" | sed -n 's/^[^#]*#[[:space:]]*//p')
		# A package name only: nothing else reaches the configuration.
		if ! printf '%s' "$package" | grep -Eq '^[A-Za-z0-9@/._-]+$'; then
			echo "licence-exceptions.txt: '$package' is not a package name" >&2
			exit 1
		fi
		if [ -z "$reason" ]; then
			echo "licence-exceptions.txt: $package has no reason (# why it is accepted)" >&2
			exit 1
		fi
		printf '  - "%s"\n' "$package" >> "$config"
	done < "$exceptions"
fi

# The installed packages only (their own metadata gives the licence): not
# the lockfiles nor the CI files a package from git may carry.
syft scan "dir:$installed" -q -o "spdx-json=$sbom" \
	--override-default-catalogers python-installed-package-cataloger,javascript-package-cataloger
grant check -c "$config" "$sbom"
