# codegraph-mandatory

Makes codegraph-first code search a rule the agent cannot forget.

## What it does

Injects the codegraph-first instruction through OpenCode's context and compaction hooks, so every session — including after context compaction — resolves file and symbol lookup through the local codegraph index before falling back to grep/glob.

## Why

"Search with codegraph first" as a chat instruction evaporates the moment context compacts. As a hook it persists: the rule is re-injected automatically, every session, no discipline required.

## Install

```sh
cp -r plugins/codegraph-mandatory ~/.config/opencode/plugins/   # global
```

Restart OpenCode. Requires a codegraph index in the projects you work in (`codegraph init`); without one the plugin's rule simply has nothing to query and normal search applies.

## Notes

- This plugin states a search policy. It does not bundle codegraph itself.
