import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[3]


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(run_dir, name, value):
    (run_dir / name).write_text(json.dumps(value) + "\n", encoding="utf-8")


def load(run_dir, name):
    value = json.loads((run_dir / name).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{name}: expected a JSON object")
    return value


def index_tree():
    return git("write-tree").decode().strip()


def verify_tree(tree, expected_paths):
    if index_tree() != tree:
        raise ValueError("The Git index changed after reproduction")
    changed = git("diff", "--name-only", "-z").split(b"\0")[:-1]
    untracked = git("ls-files", "--others", "--exclude-standard", "-z")
    if changed != expected_paths or untracked:
        raise ValueError(f"Unexpected working tree changes: {changed!r}, {untracked!r}")


def run_test(expected_code):
    test = subprocess.run(
        [sys.executable, "-B", "-m", "unittest", "-v", "test_duration"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    expected_failure = "AssertionError: 200 != 120 : DURATION_SCALE"
    if (
        test.returncode != expected_code
        or "Ran 1 test" not in test.stdout
        or (expected_code == 1 and expected_failure not in test.stdout)
    ):
        raise ValueError(
            f"Test exited with {test.returncode}, expected {expected_code}.\n{test.stdout}"
        )
    return {"exit_code": test.returncode, "result": test.stdout.strip()}


def check_verdict(run_dir, report, subject):
    review = load(run_dir, report)
    subject_sha256 = digest((run_dir / subject).read_bytes())
    if review.get("subject_sha256") != subject_sha256:
        raise ValueError(f"{report}: review is for a different version of {subject}")
    reason = review.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError(f"{report}: review needs a reason")
    if review.get("verdict") != "PASS":
        raise ValueError(f"{report}: PASS is required to continue")
    return {"verdict": "PASS", "subject_sha256": subject_sha256}


def reproduce(run_dir):
    tree = index_tree()
    verify_tree(tree, [])
    result = run_test(1)
    save(run_dir, "baseline.json", {"index_tree": tree})
    return {"test": "EXPECTED FAILURE", **result}


def prepare_plan_review(run_dir):
    for name in ("research-code.md", "research-rules.md", "plan.md"):
        if not (run_dir / name).read_bytes().strip():
            raise ValueError(f"{name}: missing content")
    previous = run_dir / "review-plan.md"
    if previous.exists():
        archive = Path(tempfile.mkdtemp(prefix="prior-review-", dir=run_dir))
        previous.rename(archive / previous.name)
    return {"plan_sha256": digest((run_dir / "plan.md").read_bytes())}


def verify_plan(run_dir):
    verify_tree(load(run_dir, "baseline.json")["index_tree"], [])
    verdict = check_verdict(run_dir, "review-plan.md", "plan.md")
    save(run_dir, "approved-plan.json", verdict)
    return verdict


def verify_candidate(run_dir):
    tree = load(run_dir, "baseline.json")["index_tree"]
    approved = load(run_dir, "approved-plan.json")
    plan_sha256 = digest((run_dir / "plan.md").read_bytes())
    if plan_sha256 != approved["subject_sha256"]:
        raise ValueError("The plan changed after approval")
    verify_tree(tree, [b"duration.py"])
    result = run_test(0)
    diff = git("diff", "--binary")
    (run_dir / "fix.diff").write_bytes(diff)
    save(run_dir, "candidate.json", {
        "plan_sha256": plan_sha256,
        "diff_sha256": digest(diff),
        "file_sha256": digest((ROOT / "duration.py").read_bytes()),
        "destination": "deploy/ under this run directory",
        "rollback": "Remove only the copy created by this step",
        "test": result,
    })
    return {"test": "PASS", **result}


def deploy(run_dir):
    verdict = check_verdict(run_dir, "review-deploy.md", "candidate.json")
    verify_tree(load(run_dir, "baseline.json")["index_tree"], [b"duration.py"])
    candidate = load(run_dir, "candidate.json")
    source = (ROOT / "duration.py").read_bytes()
    if (
        digest(git("diff", "--binary")) != candidate["diff_sha256"]
        or digest(source) != candidate["file_sha256"]
        or digest((run_dir / "plan.md").read_bytes()) != candidate["plan_sha256"]
    ):
        raise ValueError("The candidate or plan changed after review")

    target = run_dir / "deploy"
    target.mkdir()
    deployed = target / "duration.py"
    try:
        deployed.write_bytes(source)
        probe = subprocess.check_output(
            [
                sys.executable, "-I", "-B", "-c",
                "import runpy; print(runpy.run_path('duration.py')['minutes_to_seconds'](2))",
            ],
            cwd=target,
            text=True,
        ).strip()
        if probe != "120":
            raise ValueError(f"Deployed copy returned {probe}, expected 120")
    except (OSError, ValueError, subprocess.CalledProcessError):
        deployed.unlink(missing_ok=True)
        raise

    return {**verdict, "destination": "deploy/duration.py", "probe": "2 minutes = 120 seconds"}


STEPS = {
    "reproduce": reproduce,
    "prepare-plan-review": prepare_plan_review,
    "verify-plan": verify_plan,
    "verify-candidate": verify_candidate,
    "deploy": deploy,
}


if __name__ == "__main__":
    try:
        result = STEPS[os.environ["PLAYBOOK_STEP"]](Path(os.environ["PLAYBOOK_RUN_DIR"]))
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from error
    print(json.dumps({"outputs": result}))
