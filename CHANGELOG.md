# Changelog

## 0.5.3

- The README follows a review-gated fix from parallel research through Revise, approval, and a
  verified local deployment. Try the included YAML example or explore its BPMN diagram.
- The quick start includes a weather example with parallel research, a script, an independent
  review, and a human decision with a revision loop.
- Graph, Timeline, and Agents use the same status markers. The graph shows step details on hover
  and keyboard focus, and routes dependencies around wrapped cards.
- Timeline uses colored event icons for starts, completions, decisions and failures. Thick and thin
  bars distinguish the row's step from other work at that time. Amber highlights steps currently
  working. Agents shows a colored status dot beside each name.

## 0.5.2

- Conversations show the first prompt in the header and on Timeline when the optional local Orca
  journal is configured.
- Agents shows worker dispatch dates. A worker's follow-up stays on Timeline and counts as another
  round of the same session.
- Timeline explains its parallel activity bars. Hover a bar to see its task.

## 0.5.1

- The timeline fits a narrow panel: times use the 24-hour clock, an event's text wraps to at most two
  lines with the full text as a tooltip, and in a narrow panel the duration goes under the text. Tabs,
  the workspace line and long ids wrap instead of running past the edge.
- No blank panel after Orca starts: the panel says "Loading…" at once, the first answer no longer waits
  for the first read of Orca Runs (the panel says agents are still being read and refreshes when the
  read ends), and a conversation's agents load without holding up the rest of the panel. The worker
  starts that read when it activates, also while the panel is closed.
- Orca's "Worker stopped without reporting" escalation is hidden when the same worker reported after it.
- `AGENTS.md`: rules for people and coding agents who change this public repository.
- README: screenshots of a playbook run, a conversation's Timeline and its Agents, made with sample data.

## 0.5.0

- Every view (playbook run, Orca Run, conversation) has the same tabs: Graph | Timeline | Agents. Where
  there is no graph (a conversation, an Orca Run without dependencies), the Graph tab says why and how
  to get one, instead of drawing unrelated tasks side by side.
- English everywhere: panel, status bar, notifications, validation messages and the instructions added
  to agent tasks.
- Playbook format: the gate loop key is `on.revise` and gate choices are OK / Revise. `on.popraw` and
  `popraw` answers, the names used by pre-release versions, are still accepted, so older playbooks and stored
  runs keep working.
- `{{now}}` and `{{date}}` use the system time zone.
- Script steps appear on the timeline when they actually ran.
- Examples in English: `weather-air` (Open-Meteo, no API key) and `sequential-vs-parallel` (script
  steps only).
- README rewritten in English, with requirements, trust, limitations and uninstall.
