# what-changed

One command that answers "what changed since X?".

## What it does

A single-file `/what-changed` command: point it at a commit, branch, tag, or merge-base and get a review of everything since, along two axes — Standards (does the code follow the repo's documented conventions?) and Spec (does it match what the originating issue or spec asked for?).

## Why

Diffs are easy to produce and hard to review. A fixed two-axis format keeps change reviews consistent whether the range is a work-in-progress branch or a release.

## Install

```sh
cp -r plugins/what-changed ~/.config/opencode/plugins/   # global
```

Restart OpenCode, then `/what-changed <since>`.

## Notes

- Single file on purpose. If it ever needs a second file, something went wrong (see ponytail-v2).
