#!/bin/sh
# The version before of the action whose repository is checked out in $1,
# from its git tags vX.Y.Z: checks it out in $2 and prints the arguments
# `check` takes for it, one per line. Prints nothing without such a tag.
# The version checked is the tag of the commit checked out, when it has one.
set -eu

action=$1
dest=$2

# The version numbers of the tags `git tag "$@"` lists, lowest first.
numbers() {
    git -C "$action" tag "$@" --list 'v*' |
        sed -n 's/^v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/\1/p' |
        sort -V
}

to=$(numbers --points-at HEAD | tail -n 1)
if [ -n "$to" ]; then
    from=$(numbers --merged HEAD | awk -v to="$to" '$0 == to { exit } { last = $0 } END { print last }')
else
    from=$(numbers --merged HEAD | tail -n 1)
fi
[ -n "$from" ] || exit 0

git -C "$action" worktree add --quiet --detach "$dest" "v$from"
printf '%s\n' --previous "$dest" --from "$from"
[ -z "$to" ] || printf '%s\n' --to "$to"
