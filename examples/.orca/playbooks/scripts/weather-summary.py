import os
from pathlib import Path
import tempfile


run_dir = Path(os.environ["PLAYBOOK_RUN_DIR"])


def read_report(step):
    report_path = run_dir / f"{step}.md"
    if not report_path.is_file():
        raise SystemExit(f"Missing step report: {step}.md")
    report = report_path.read_text(encoding="utf-8").strip()
    if not report:
        raise SystemExit(f"Empty step report: {step}.md")
    return report


step = os.environ["PLAYBOOK_STEP"]
if step == "summary":
    forecast = read_report("forecast")
    air = read_report("air")
    print(f"Sample weather and air quality\n\n{forecast}\n\n{air}")
elif step == "prepare-review":
    plan = read_report("plan")
    snapshot = run_dir / "plan-for-review.md"
    if snapshot.exists() and plan == read_report("plan-for-review"):
        raise SystemExit("Revise requires an updated plan.")
    previous = [file for file in (snapshot, run_dir / "review.md") if file.exists()]
    if previous:
        archive = Path(tempfile.mkdtemp(prefix="prior-plan-", dir=run_dir))
        for file in previous:
            file.rename(archive / file.name)
    snapshot.write_text(plan + "\n", encoding="utf-8")
    print("Plan saved for review.")
elif step == "finish":
    review = read_report("review")
    if review.splitlines()[0] != "PASS":
        raise SystemExit("The plan needs a PASS from the reviewer.")
    plan = read_report("plan")
    if plan != read_report("plan-for-review"):
        raise SystemExit("The plan changed after review.")
    print(plan)
else:
    raise SystemExit(f"Unknown step: {step}")
