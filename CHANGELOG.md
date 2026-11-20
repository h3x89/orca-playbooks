# Changelog

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
