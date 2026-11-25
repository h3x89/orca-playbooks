"""Compile the explicitly mapped subset used by examples/asdlc/process.bpmn."""

import json
import sys
from collections import defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET

NS = "{http://www.omg.org/spec/BPMN/20100524/MODEL}"
TASKS = {"serviceTask": "agent", "scriptTask": "script", "userTask": "gate"}
ROUTING = {"startEvent", "endEvent", "parallelGateway", "exclusiveGateway"}


def kind(node):
    if not node.tag.startswith(NS):
        raise ValueError(f"Unsupported element {node.get('id', node.tag)}")
    return node.tag[len(NS):]


def compile_process(model, binding):
    processes = model.findall(f"{NS}process")
    if len(processes) != 1:
        raise ValueError("Expected exactly one BPMN process.")
    process = processes[0]
    nodes = {}
    flows = {}
    for node in process:
        node_kind = kind(node)
        if node_kind in {"documentation", "laneSet"}:
            continue
        node_id = node.get("id")
        if node_kind not in {*TASKS, *ROUTING, "sequenceFlow"}:
            raise ValueError(f"Unsupported element {node_id or node_kind} ({node_kind}).")
        if not node_id or node_id in nodes or node_id in flows:
            raise ValueError(f"Missing or duplicate id {node_id}.")
        allowed_children = {"documentation", "conditionExpression"} if node_kind == "sequenceFlow" else {"documentation", "incoming", "outgoing"}
        for child in node:
            child_kind = kind(child)
            if child_kind not in allowed_children:
                raise ValueError(f"{node_id}: unsupported {child_kind}.")
        (flows if node_kind == "sequenceFlow" else nodes)[node_id] = node

    tasks = {node_id: node for node_id, node in nodes.items() if kind(node) in TASKS}
    if set(tasks) != set(binding["steps"]):
        difference = set(tasks).symmetric_difference(binding["steps"])
        raise ValueError(f"Step bindings differ from model: {', '.join(sorted(difference))}.")
    policy = binding["flows"]
    if not set(policy) <= set(flows):
        raise ValueError(f"Unknown flow binding {next(iter(set(policy) - set(flows)))}.")
    inbound = defaultdict(list)
    outbound = defaultdict(list)
    decisions = {}
    blocked = []
    revisions = []
    for flow_id, flow in flows.items():
        source, target = flow.get("sourceRef"), flow.get("targetRef")
        if source not in nodes or target not in nodes:
            raise ValueError(f"{flow_id}: unknown source or target.")
        role = policy.get(flow_id)
        if flow.find(f"{NS}conditionExpression") is not None and role is None:
            raise ValueError(f"{flow_id}: condition needs an explicit mapping.")
        if role is not None:
            if kind(nodes[source]) != "exclusiveGateway":
                raise ValueError(f"{flow_id}: conditional source must be an exclusive gateway.")
            decisions.setdefault(source, []).append(role)
        if role == "revise":
            revisions.append((flow_id, source, target))
            continue
        if role in {"block", "limit"}:
            if kind(nodes[target]) != "endEvent":
                raise ValueError(f"{flow_id}: a stop flow must lead to an end event.")
            blocked.append((flow_id, source, role))
            continue
        if role not in {None, "accept", "pass"}:
            raise ValueError(f"{flow_id}: unsupported flow mapping {role}.")
        inbound[target].append(source)
        outbound[source].append(target)

    for source, node in nodes.items():
        if kind(node) != "exclusiveGateway":
            continue
        if len(inbound[source]) > 1:
            raise ValueError(f"{source}: merging multiple exclusive paths is unsupported.")
        if len(outbound[source]) > 1 and source not in decisions:
            raise ValueError(f"{source}: exclusive gateway needs explicit flow mappings.")

    for source, roles in decisions.items():
        if sorted(roles) not in (["block", "pass"], ["accept", "limit", "revise"]):
            raise ValueError(f"{source}: unsupported exclusive branch combination.")
        if len(outbound[source]) != 1:
            raise ValueError(f"{source}: must have one continuing flow.")

    # Check graph topology before using it to trace dependencies through routing nodes.
    start = [node_id for node_id, node in nodes.items() if kind(node) == "startEvent"]
    if len(start) != 1:
        raise ValueError("Expected one start event.")
    visited = set()
    current = set()
    order = []

    def visit(node_id):
        if node_id in current:
            raise ValueError(f"Unsupported cycle through {node_id}.")
        if node_id in visited:
            return
        current.add(node_id)
        for following in outbound[node_id]:
            visit(following)
        current.remove(node_id)
        visited.add(node_id)
        order.append(node_id)

    visit(start[0])
    if not set(tasks) <= visited:
        raise ValueError(f"Unreachable task {next(iter(set(tasks) - visited))}.")

    def nearest(node_id, neighbors):
        if node_id in tasks:
            return [node_id]
        return list(dict.fromkeys(item for edge in neighbors[node_id] for item in nearest(edge, neighbors)))

    for flow_id, source, role in blocked:
        before = nearest(source, inbound)
        required = "scriptTask" if role == "block" else "userTask"
        if len(before) != 1 or kind(nodes[before[0]]) != required:
            raise ValueError(f"{flow_id}: a {role} mapping needs one {required} before the split.")

    steps = {}
    for node_id in reversed(order):
        if node_id not in tasks:
            continue
        node = tasks[node_id]
        details = binding["steps"][node_id]
        expected = TASKS[kind(node)]
        if expected not in details or set(details) & (set(TASKS.values()) - {expected}) or set(details) & {"id", "title", "needs", "on"}:
            raise ValueError(f"{node_id}: expected {expected} binding without graph overrides.")
        needs = list(dict.fromkeys(item for edge in inbound[node_id] for item in nearest(edge, inbound)))
        step = {"id": node_id, "title": node.get("name") or node_id}
        if needs:
            step["needs"] = needs
        steps[node_id] = {**step, **details}

    for flow_id, source, target in revisions:
        gate, goto = nearest(source, inbound), nearest(target, outbound)
        limit = binding["revisionLimits"].get(flow_id)
        if len(gate) != 1 or len(goto) != 1 or "gate" not in steps[gate[0]] or "gate" in steps[goto[0]]:
            raise ValueError(f"{flow_id}: cannot trace a gate and one restart step.")
        if type(limit) is not int or not 1 <= limit <= 5 or "on" in steps[gate[0]]:
            raise ValueError(f"{flow_id}: expected one revision limit between 1 and 5.")
        steps[gate[0]]["on"] = {"revise": {"goto": goto[0], "max_loops": limit}}

    # Preserve visual declaration order and let Orca calculate the dependency order.
    return {"title": process.get("name"), "description": binding["description"],
            "steps": [steps[node_id] for node_id in tasks]}


def to_yaml(playbook):
    # JSON scalars, lists and maps are YAML 1.2 flow values.
    encode = lambda value: json.dumps(value, ensure_ascii=False)
    lines = [f"title: {encode(playbook['title'])}", f"description: {encode(playbook['description'])}", "steps:"]
    for step in playbook["steps"]:
        lines.append(f"  - id: {encode(step['id'])}")
        for key, value in step.items():
            if key == "id":
                continue
            if isinstance(value, str) and "\n" in value:
                trailing = len(value) - len(value.rstrip("\n"))
                chomp = "" if trailing == 1 else ("+" if trailing else "-")
                lines.append(f"    {key}: |{chomp}")
                content = value.removesuffix("\n")
                lines.extend("      " + line if line else "" for line in content.split("\n"))
            else:
                lines.append(f"    {key}: {encode(value)}")
    return "\n".join(lines) + "\n"


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: bpmn-to-orca.py process.bpmn bindings.json")
    try:
        raw = Path(sys.argv[1]).read_text()
        if "<!DOCTYPE" in raw.upper():
            raise ValueError("Document type declarations are outside this BPMN subset.")
        model = ET.fromstring(raw)
        binding = json.loads(Path(sys.argv[2]).read_text())
        print(to_yaml(compile_process(model, binding)), end="")
    except (ValueError, KeyError, ET.ParseError, OSError) as error:
        raise SystemExit(f"BPMN: {error}") from error


if __name__ == "__main__":
    main()
