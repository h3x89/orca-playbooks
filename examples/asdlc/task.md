# Fix the duration conversion

Two minutes should equal 120 seconds. Reproduce the failure, change only
`duration.py`, and run the same test again.

The plan and its independent review must pass the human decision gate before
the code changes. After the passing retest, a fresh reviewer checks the exact
candidate and the local deployment plan. The deployment copies the approved
file into a new directory for this run and checks that a new Python process
returns `120` from the copy.

If that check fails, remove only the copy created by this run. The test and
playbook stay fixed while the agent repairs the example.
