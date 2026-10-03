# block-env

A 36-line OpenCode permission hook with one job: keep secrets out of agent reach.

## What it does

- Denies all access to `.env*` files (read, write, scan).
- Denies recursive scans (find/grep over whole trees) unless they carry an `--exclude` rule.
- Short, readable, no dependencies: the whole policy fits in one file.

## Why

Agents exploring a codebase will happily `cat .env` or `grep -r` across everything, including secrets. This hook makes that class of mistake structurally impossible instead of relying on instructions the model might ignore.

## Install

```sh
cp -r plugins/block-env ~/.config/opencode/plugins/   # global
```

Restart OpenCode. There is nothing to configure.

## Notes

- If a legitimate task needs a `.env` file, the human does that part. The agent never touches it.
