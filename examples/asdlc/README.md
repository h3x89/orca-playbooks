# Review-gated fix

Run a small change through parallel research, a human decision, and two
independent reviews. All task inputs are fictional. The example deploys a copy
of one Python file inside the run directory.

## Run it

You need Orca Playbooks, Git, Python 3.8 or later, and Codex configured in Orca. The six
agent steps use your configured Codex model. Each Revise adds two more agent
sessions, one for the new plan and one for its review.

From the Orca Playbooks repository, prepare a standalone workspace:

```sh
demo=$(mktemp -d)
cp -R examples/asdlc/. "$demo/"
git -C "$demo" init
git -C "$demo" add .
printf '%s\n' "$demo"
```

Add that directory to Orca as a Git repository. In **Playbooks**, open **Catalog**,
find **Review-gated fix** in that repository, and choose **Open playbook**. Click **Start**
in the workspace view.

1. Open **Graph**. Both research agents and the reproduction script are ready
   at the start. The plan waits for all three results.
2. On the decision card, read the independent plan review. In **Graph**,
   select **Write a plan from both reports** and open **Step result** to read
   the plan. Choose **Revise** with a comment that addresses the review, for
   example `Name the exact test command and the deployment path.` A new
   author and reviewer run using the original research.
3. Read the new plan and review. Choose **Approve** once the review says `PASS`.
   The plan check compares the verdict with the exact plan digest before the
   fix starts. Choosing **Approve** on a `BLOCK` verdict stops the run.
4. Open **Graph** and select **Rerun the test and record the candidate**.
   The same test that reproduced the error now passes. The candidate review
   covers this test, the diff, the deployment location, and rollback.
5. Select **Verify the verdict and run the deployed copy**. The final result
   reads `2 minutes = 120 seconds`. The deployed copy and reports are inside
   `.orca/runs/` for this workspace.

Each step has a **Step result** when a report is available. Agent sessions are
kept open for inspection in the demo workspace.

In Timeline, **Superseded** marks downstream steps replaced before they started.
**Sent back · Revise** records the decision to return the plan. Graph shows
the active attempt.

For another run, use a fresh copy of the example. The reproduction script
expects the starting Git state and the original failing test.

## Follow the run in Orca

See the [repository overview](../../README.md#human-in-the-loop-example) for
the Graph, the decision card after Revise, and the local deployment result
from this run.

## Process and execution

- [BPMN 2.0 process](process.bpmn) shows roles, parallel work, the decision,
  the revision loop, and the exits after approval, testing, and deployment.
- [Playbook YAML](.orca/playbooks/review-gated-fix.yaml) defines the prompts,
  script steps, and dependencies used by Orca.
- [Verification script](.orca/playbooks/scripts/check.py) checks SHA-256
  digests, the allowed Git diff, and the deployed copy. A review with
  `BLOCK`, a missing report, or a mismatched digest stops dependent work.

### Generate the example YAML from BPMN

With Python 3.9 or later, run this from the plugin repository:

```sh
python3 tools/bpmn-to-orca.py examples/asdlc/process.bpmn \
  examples/asdlc/orca-bindings.json > /tmp/review-gated-fix.yaml
```

The BPMN provides the task names, parallel dependencies, and decision and
revision paths. The [Orca bindings](orca-bindings.json) provide model and script
settings, prompts, revision limits, and the meaning of named transitions. In
this example a blocked check becomes a failed script step. The script still
owns the verdict and digest check. The generator supports the constructs
exercised by this example and reports unsupported nodes or branches.
