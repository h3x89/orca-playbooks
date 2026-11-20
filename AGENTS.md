# Working in this repository

Rules for anyone, person or coding agent, who changes this repository. The repository is public:
every commit, branch name, tag, pull request and comment can be read by everyone.

## Content

- Write everything in English: code, comments, panel text, README, CHANGELOG, commit messages, branch
  names, tags, pull requests and replies to issues.
- Keep private context out: local paths, host names, workspace, run or session ids from a real machine,
  links to private repositories or issues, names of companies or clients, network addresses and account
  names. Tests and examples use made-up data.
- Screenshots for the README come from a demo workspace with sample data only.

## Commits

- Commit with your GitHub noreply address. Before pushing, check that
  `git log --format='%ae %ce' origin/main..HEAD` shows only noreply addresses.
- Do not import commits from other repositories or older histories; bring a change over as a new commit.
- A private detail removed by a later commit is still in the history. Stop and tell the maintainer: it
  needs a history rewrite, not another commit.

## Changes

- Work on a branch and open a pull request; do not push to `main`.
- Before a pull request: `orca plugin validate .` and `orca plugin test .` pass. When you change the
  panel, look at it narrow (about 240 px) and wide.
- Do not add CI workflows, review bots, GitHub Pages or Wiki pages without the maintainer's decision:
  their output is public too.

## Releases

- Raise `version` in `orca-plugin.json` and add an entry to `CHANGELOG.md`.
- Before tagging `vX.Y.Z` on `main`, review everything the release publishes (files, history, pull
  request texts) for private context.
