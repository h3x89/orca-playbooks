// The panel <-> worker contract, declared once: panel/index.html and src/worker.ts both follow it.
export {}

export type WorkspaceInfo = {
  id: string
  name: string
  path: string
  branch: string | null
  projectId?: string
  projectName?: string
}

export type CatalogEntry = {
  workspace: WorkspaceInfo
  playbooks: Pick<PlaybookInfo, 'file' | 'title' | 'description' | 'errors'>[]
  error?: string
}

export type WaitingDecision = {
  workspaceId: string
  runId: string
  title: string
  stepId: string
  stepTitle: string
  ticket?: string
}

export type StepInfo = {
  id: string
  title: string
  kind: 'agent' | 'script' | 'gate'
  needs: string[]
  depth: number
  agent?: string
  model?: string
  effort?: string
  keepOpen?: boolean
  run?: string
  question?: string
  loop?: { goto: string; maxLoops: number }
}

export type PlaybookInfo = {
  inputFields?: import('./playbook').InputField[]
  file: string
  id: string
  title: string
  description: string
  errors: string[]
  steps: StepInfo[]
}

/** Live state of the agent working on a step, from Orca's agent list (`agent:read`). */
export type AgentLive = { state: 'working' | 'blocked' | 'waiting' | 'done'; since: number; terminalId?: string }

export type StepRun = {
  /** The Orca task of the current attempt. */
  taskId: string
  /** Orca task status (`pending`, `ready`, `dispatched`, `blocked`, `completed`, `failed`). */
  status: string
  /** 1 for the first run, +1 for every revise loop that ran the step again. */
  attempt: number
  dispatchId?: string
  /** The optional native chat adapter can look up this attempt's tab. */
  chatAvailable?: boolean
  gateId?: string
  /** `popraw` only in runs stored by versions before 0.5.0; it means `revise`. */
  decision?: 'ok' | 'revise' | 'popraw'
  comment?: string
  startedAt?: number
  endedAt?: number
  /** Start of the step's result file (`<runDir>/<step>.md` or `.txt`), at most 4000 characters. */
  output?: string
  error?: string
  /** The agent working on this attempt right now, when Orca lists it. */
  live?: AgentLive
}

export type RunInfo = {
  id: string
  title: string
  playbookFile: string
  workspaceId: string
  workspaceName: string
  workspacePath: string
  status: 'running' | 'waiting' | 'done' | 'failed' | 'rejected'
  createdAt: number
  updatedAt: number
  runDir: string
  /** Orca terminal the plugin coordinates the Run from (`--from`). */
  handle: string
  inputs: Record<string, string>
  /** Revise loops already run. */
  loops: number
  error?: string
  steps: StepInfo[]
  tasks: Record<string, StepRun>
}

/** One task of any Orca orchestration Run, drawn as a node. */
export type RunNode = {
  id: string
  title: string
  taskTitle: string
  status: string
  attempt?: number
  needs: string[]
  depth: number
  agent?: string
  model?: string
  effort?: string
  dispatchId?: string
  workerState?: string
  liveness?: string
  terminalId?: string
  outcome?: string
  workspacePath?: string
  result?: string
  createdAt?: number
  live?: AgentLive
}

/** An Orca Run started outside this plugin (a coordinator agent's reviews, research, …) that worked in this workspace. */
export type OrcaRunSummary = {
  id: string
  objective: string
  /** The objective for a one-task Run; "N tasks · last: …" when one Run holds a whole coordinator session. */
  title: string
  createdAt: number
  updatedAt: number
  workers: number
  tasks: number
  active: boolean
  coordinatedByAgent?: boolean
}

/** One thing that happened in a Run, for the top-down timeline. */
export type TimelineEvent = {
  at: number
  /** Order Orca recorded it in, for events in the same millisecond. */
  order: number
  kind: 'created' | 'started' | 'follow-up' | 'done' | 'failed' | 'superseded' | 'sent-back' | 'report' | 'question' | 'escalation' | 'message' | 'gate' | 'decision'
  taskId?: string
  attempt?: number
  title: string
  detail?: string
  duration?: number
  /** Column of the task for drawing parallel work; tasks reuse a lane once the previous one ended. */
  lane?: number
  spanStart?: number
  spanEnd?: number
}

/** A replaced task, as recorded by Orca. Its report does not overwrite the current attempt's file. */
export type TimelineStep = RunNode & {
  kind: 'agent' | 'script' | 'gate'
  chatAvailable?: boolean
  resultUnavailable?: boolean
  decision?: StepRun['decision']
  comment?: string
}

/** Work a session runs inside itself, as Orca observes it live (`worktree ps` children): background commands, native subagents, workflows. */
export type SessionChild = { kind: string; description?: string; state?: string; since?: number; observedAt?: number }

/** An agent session (chat or terminal) of the workspace, with what Orca knows about it now. */
export type SessionInfo = {
  id: string
  paneKey: string
  parentPaneKey?: string
  title: string
  agent?: string
  state: string
  since?: number
  outcome?: string
  tool?: string
  toolInput?: string
  lastMessage?: string
  children: SessionChild[]
  /** `live` when Orca watches this session's own subagents; `unverifiable` when it cannot. */
  subagents?: string
  updatedAt?: number
  firstPromptAt?: number
  /** State of the conversation's own last turn (the session as a whole may be `working` while it only monitors helpers). */
  mainState?: string
  mainSince?: number
  /** e.g. `monitoring`: the session waits for the helpers it started. */
  workingMode?: string
  /** Orca Runs whose tasks this conversation dispatched (`dispatch.creator_orca_session_id`). */
  runIds?: string[]
  /** How many tasks (agents) this conversation dispatched in those Runs. */
  agents?: number
  /** This session is itself a worker some conversation dispatched (not a conversation of its own). */
  isWorker?: boolean
}

/** One agent a conversation started: a task of one of its Runs, with its worker. */
export type SessionAgent = RunNode & { runId: string; startedAt?: number; endedAt?: number; workerSessionId?: string }

/** A waiting run that cannot be opened as a decision. */
export type UnavailableWaitingRun = { title: string; workspaceName: string; reason: 'workspace-unavailable' | 'decision-unavailable' }

declare module 'orca' {
  interface PluginRequests {
    /** The workspace in focus (or `workspaceId` when the person picked one), its playbooks, its playbook runs and the other Orca Runs that worked there. */
    'state.get': {
      input: { workspaceId?: string }
      output: {
        workspaces: WorkspaceInfo[]
        workspaceId: string | null
        /** True when the workspace is the one in focus, false when picked by hand or guessed. */
        following: boolean
        /** True while the first read of Orca Runs after a start is still running: conversations have no agents yet. */
        indexing: boolean
        playbooks: PlaybookInfo[]
        runs: RunInfo[]
        orcaRuns: OrcaRunSummary[]
        sessions: SessionInfo[]
        unavailableRuns: UnavailableWaitingRun[]
        waitingDecisions: WaitingDecision[]
      }
    }
    /** Saved playbooks from the local workspaces, read when the Catalog is opened. */
    'catalog.list': { input: Record<string, never>; output: { entries: CatalogEntry[] } }
    /** The graph of one Orca Run: its tasks, deps, workers and live agent states. */
    'orca.run': { input: { runId: string }; output: { nodes: RunNode[] } }
    /** Everything one conversation started: its agents across its Runs and one timeline of all their work. */
    'session.view': { input: { sessionId: string; runIds: string[] }; output: { agents: SessionAgent[]; events: TimelineEvent[]; lanes: number } }
    /** The timeline of one Orca Run (also a playbook run): tasks, worker starts, reports, gates and decisions. */
    'run.timeline': { input: { runId: string }; output: { events: TimelineEvent[]; lanes: number; history?: TimelineStep[] } }
    /** The last lines of a worker's transcript. */
    'step.lines': { input: { dispatchId: string }; output: { lines: string[] } }
    'step.openChat': { input: { runId: string; taskId: string }; output: { opened: boolean } }
    /** Opens a file named by a current step in its playbook's workspace. */
    'step.openFile': { input: { runId: string; taskId: string; kind: 'script' | 'result' }; output: { opened: boolean } }
    /** Shows the agent of a step: its terminal when Orca lists one, else its workspace. */
    'agent.show': { input: { terminalId?: string; workspacePath?: string; workspaceId?: string }; output: { shown: 'terminal' | 'workspace' | 'none' } }
    /** Opens a workspace, as clicking it in the sidebar does. */
    'workspace.goto': { input: { workspaceId: string }; output: { opened: boolean } }
    /** Starts a run of `<workspace>/.orca/playbooks/<file>`. */
    'run.start': { input: { workspaceId: string; file: string; inputs?: Record<string, string> }; output: { run: RunInfo } }
    /** Answers the open gate of `stepId`: `ok` continues, `revise` loops back (or stops the run) with the comment; `popraw` is a legacy alias of `revise`. */
    'gate.resolve': { input: { runId: string; stepId: string; choice: 'ok' | 'revise' | 'popraw'; comment?: string }; output: { run: RunInfo } }
  }
  interface PluginPanelEvents {
    /** Posted after any run changes. */
    'runs.changed': { runs: RunInfo[] }
    /** Posted once the first read of Orca Runs after a start has finished (see `indexing` in `state.get`). */
    'index.ready': Record<string, never>
  }
}
