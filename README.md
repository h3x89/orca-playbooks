# Playbooks for Orca

An [Orca](https://github.com/stablyai/orca) plugin that runs agent workflows kept as YAML files in your
repository, and shows any agent work in a workspace as a graph, a timeline and a list of agents.

A playbook is a list of steps: agent steps, script steps and human decision gates, linked by `needs`.
The plugin turns a playbook into an ordinary Orca orchestration Run (one task per step), starts an Orca
worker for every agent step, runs script steps itself and asks you at every gate, where you approve or
send the work back with a comment. The same panel also shows Orca Runs started by other agents and
conversations that started agents.

## Requirements

- Orca **1.4.263 or newer** on macOS. The plugin needs host API 1.10 (`agents.list` with `workspaceId`,
  first shipped in Orca 1.4.261); it is tested on Orca 1.4.263–1.4.266. Linux and Windows are untested.
- The `orca` CLI: the plugin uses `/Applications/Orca.app/Contents/Resources/bin/orca` when present,
  else `orca` on `PATH`.
- `python3` for `.py` script steps, and the agents your playbooks name, set up in Orca.
- Workspaces on this computer only (see Limitations).

## Quick start

1. Install the plugin from a folder:

   ```sh
   git clone https://github.com/h3x89/orca-playbooks.git
   orca plugin install ./orca-playbooks --json   # lists what it asks for and prints a fingerprint
   orca plugin install ./orca-playbooks --approve <fingerprint>
   ```

   or straight from Git (Orca takes the newest `vX.Y.Z` tag, else the default branch):

   ```sh
   orca plugin install h3x89/orca-playbooks --json
   orca plugin install h3x89/orca-playbooks --approve <fingerprint>
   ```

2. Copy `examples/.orca/playbooks/` to `.orca/playbooks/` in a repository that is a workspace in Orca.
3. Open that workspace, then the **Playbooks** panel in the right sidebar.
4. Pick **Sequential vs parallel** (script steps only, no agent) and press **Start**. Watch the Graph
   and Timeline tabs, then answer the gate with **OK**.
5. Try **Weather and air**: two scripts fetch the forecast and air quality from
   [Open-Meteo](https://open-meteo.com) (no API key), a Claude agent writes a plan, and you approve it or
   press **Revise** with a comment to have the plan written again.

## Trust

Install this plugin only if you trust its code, and start only playbooks from repositories you trust.

- The plugin runs as a `trusted-worker`: a Node process with the rights of your user account. It runs
  the `orca` CLI and the scripts of a playbook (`<repo>/.orca/playbooks/scripts/`).
- Script steps get only `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TMPDIR` and `PLAYBOOK_*` variables.
  This is not a sandbox: a script can do anything your account can.
- An agent step starts an Orca worker on your account with a prompt from the repository. What the agent
  may do depends on that agent's permission settings in Orca; in a permission-bypass mode, a prompt
  alone can run commands. Every agent step uses your subscription or API quota, and Revise runs steps
  again (at most `max_loops` times, up to 5).
- The panel lists every local workspace, including cloned repositories of other people: a playbook from
  someone else's repository looks the same as your own.
- **Last lines** of worker transcripts are shown with a simple mask for strings that look like tokens;
  take care when sharing screenshots.
- The plugin has no hooks and changes no Orca or agent settings. Besides the terminals it opens, it
  writes only to `<repo>/.orca/runs/` and its own plugin storage.

Capabilities it asks for: `storage:own` (the runs it started), `workspace:read` (the workspace in focus
and the list of workspaces), `workspace:write` (focus an agent's terminal, open a workspace),
`agent:read` (live agent states), `terminal:send`, `notifications:show`. Orca describes `terminal:send`
broadly (open and close terminals, type and run commands in your terminals, local and over SSH); the
plugin uses it only to open the coordinator terminal of each run it starts.

`ORCA_CLI_COMMAND`, when set in Orca's environment, replaces the `orca` binary the plugin calls; it is
meant for development and the tests.

## The panel

The panel follows the workspace selected in Orca's left sidebar (**Pin** keeps it on one). It shows:

- the playbooks of the workspace and **Start**;
- **Run or conversation**: playbook runs, conversations of this workspace that started agents, and other
  Orca Runs whose workers worked here;
- the same tab row for each of them: **Graph | Timeline | Agents (N)**.

| Tab | Playbook run | Orca Run started by an agent | Conversation |
| --- | --- | --- | --- |
| Graph | steps and `needs`, live states, the Revise loop | tasks and their dependencies; without dependencies, a note instead of a graph | a note: a conversation declares no dependencies |
| Timeline | task created, worker started, questions, reports, gates, decisions and ends, with durations; bars on the left show who worked in parallel | the same | all work of all its agents, across its Runs |
| Agents | agent steps with model, state, start and duration | tasks a worker took | every agent the conversation started |

Where the Graph tab has no graph, it says why and how to get one: describe the work as a playbook in
`.orca/playbooks/` and start it from the panel. Click a step, a timeline row or an agent to see its
result, the **Last lines** of its transcript and **Show agent** (focuses its terminal, or opens its
workspace when Orca no longer lists the terminal).

A decision card appears above the tabs when a gate waits for you, and a banner when one waits in another
workspace. Orca notifications and the status bar item say when a run waits for you, fails, is sent back
or finishes.

### Conversations and their agents

Orca records which conversation dispatched each orchestration task: `dispatch.creator_orca_session_id`
in `orca orchestration dispatch-show --task <id>`. The plugin reads it for recent Runs (the 60 newest in
`run-list`) and puts every agent a conversation started, in any of those Runs, under that conversation.
A Run dispatched by a conversation of the selected workspace is not listed again on its own. A decision
gate nobody dispatched belongs to the conversation when it is the only one dispatching in that Run.

A conversation's state reads "waiting for you · last reply HH:MM", "waiting for its helpers" or
"working". The panel also shows the work Orca observes inside a session right now (background commands,
native subagents); Orca keeps no history of it.

## Playbook format

A playbook is `<repo>/.orca/playbooks/<name>.yaml`; its scripts live in `<repo>/.orca/playbooks/scripts/`.
Results of a run go to `<repo>/.orca/runs/<run_id>/` (the plugin adds a `.gitignore` there).

```yaml
title: Weather and air
description: Shown under the playbook in the panel.
inputs:                      # defaults; {{inputs.<name>}} in prompts, PLAYBOOK_INPUT_<NAME> in scripts
  activity: { default: running }
steps:
  - id: weather
    script: { run: weather.py, timeout_sec: 120 }   # .py runs with python3, .sh with /bin/sh, others directly
  - id: plan
    needs: [weather]
    agent: claude            # claude, codex, opencode, opencode2, cursor, antigravity, grok, muse, zcode, pi, omp
    model: claude-sonnet-5-5 # optional; effort only together with model
    keep_open: true          # optional: the worker's terminal stays open after the work
    prompt: |
      Today is {{date}}, the time is {{now}}. Read {{run_dir}}/weather.txt and write a plan.
  - id: decision
    needs: [plan]
    gate: { question: Approve the plan? }
    on:
      revise: { goto: plan, max_loops: 2 }   # Revise with a comment runs plan again
```

- A step has exactly one of `agent`, `script`, `gate`; `id` is lowercase letters, digits, `-` or `_`;
  at most 40 steps; `needs` must not form a cycle.
- An agent step writes its result to `{{run_dir}}/<id>.md` (the plugin adds this to the prompt, with
  "do not commit or push" and how to report back). A script step's result is its last stdout line
  `{"outputs": {...}}` when there is one, else all of stdout, saved to `{{run_dir}}/<id>.txt`.
- Variables in prompts: `{{run_dir}}`, `{{date}}` and `{{now}}` (system time zone), `{{step}}`,
  `{{comment}}`, `{{inputs.<name>}}`. The comment of a Revise is also appended to the prompt of the step
  that runs again.
- `on.revise.goto` must name a step the gate depends on; that step, every step between it and the gate,
  the gate and everything after it run again. On Revise, a gate without `on.revise`, or with no loops
  left, ends the run as sent back.

A run is an ordinary Orca Run, so agents and scripts can read it with
`orca orchestration task-list --run <run_id>` and `gate-list --run <run_id> --full`. Start runs and
answer gates from the panel: `orca orchestration gate-resolve` from another terminal fails with
"Gate not found", because Orca looks for the gate in the caller's Run. If a gate is resolved some other
way, the plugin still reads the decision; it accepts only `ok` or `revise: <comment>` and asks again on
any other answer.

## Limitations

- Workspaces on this computer only: workspaces on SSH hosts and paired Orca servers are not listed.
- Native subagents (for example Claude Code's Agent tool) are shown only while Orca observes them live;
  they are not on the Timeline or the Agents tab.
- No **Abandon** or **Retry step** button. A worker that fails to start fails its step and is not
  retried. If the coordinator terminal is closed or Orca restarts, a run can stay "running" with an
  error; disabling the plugin stops it from being polled.
- Every **Start** opens a terminal named "Playbook: …". It is the run's identity in Orca (`--from`) and
  runs only `cat >/dev/null`, so a notification Orca types into it is never run by a shell. Close it
  when the run is over.
- The plugin keeps the 20 newest playbook runs.
- It reads JSON from `orca orchestration … --json`; a change in those commands in a later Orca release
  can break parts of the panel.

## Development

```sh
orca plugin validate .
orca plugin test .         # parser, timeline, and full runs against a fake orca CLI (test/fake-orca.mjs)
orca plugin types .        # writes the Orca typings to .orca/types/
```

The repository is public, and so is every commit and pull request: read `AGENTS.md` before changing it.

## Uninstall

```sh
orca plugin list                     # the plugin key: local.playbooks from a folder, h3x89.playbooks from Git
orca plugin uninstall <plugin-key>
```

Close any "Playbook: …" terminals that are still open. You can delete `<repo>/.orca/runs/`. Runs and
tasks stay in Orca's orchestration history.

## License

MIT, see `LICENSE`. The YAML parser in `vendor/yaml` is yaml 2.9.1 (ISC). The way the worker calls
`orca orchestration` follows [Agent Pipeline](https://github.com/Alexander-64/orca-pipeline) (MIT); no
code is copied. Details in `NOTICE`.
