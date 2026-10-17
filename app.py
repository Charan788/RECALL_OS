"""RecallOS: persistent, connected memory for collaborating agents."""

import os
import re
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from falkordb import FalkorDB

load_dotenv()

ROOT = Path(__file__).parent
app = FastAPI(title="RecallOS", description="Graph memory for collaborating agents")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


class MemoryInput(BaseModel):
    project: str = Field(min_length=1, max_length=100)
    decision: str = Field(min_length=1, max_length=500)
    incident: str = Field(min_length=1, max_length=500)
    lesson: str = Field(min_length=1, max_length=500)
    agent: str = Field(default="Planner Agent", min_length=1, max_length=100)


class HandoffInput(BaseModel):
    project: str = Field(min_length=1, max_length=100)
    task: str = Field(min_length=1, max_length=500)
    from_agent: str = Field(default="Planner Agent", min_length=1, max_length=100)
    to_agent: str = Field(default="Support Agent", min_length=1, max_length=100)


def workspace_name(request: Request) -> str:
    """Read a safe workspace slug from a header; each slug gets a separate graph."""
    workspace = request.headers.get("x-workspace", "demo").strip().lower()
    if not re.fullmatch(r"[a-z0-9_-]{1,40}", workspace):
        raise HTTPException(status_code=400, detail="Workspace may use letters, numbers, _ and - only.")
    return workspace


def graph_connection(workspace: str = "demo"):
    """Create a client connection and select this demo's graph namespace."""
    options = {
        "host": os.getenv("FALKORDB_HOST", "localhost"),
        "port": int(os.getenv("FALKORDB_PORT", "6379")),
    }
    if os.getenv("FALKORDB_USERNAME"):
        options["username"] = os.environ["FALKORDB_USERNAME"]
    if os.getenv("FALKORDB_PASSWORD"):
        options["password"] = os.environ["FALKORDB_PASSWORD"]
    client = FalkorDB(**options)
    base_graph = os.getenv("FALKORDB_GRAPH", "recallos_demo")
    graph_name = base_graph if workspace == "demo" else f"{base_graph}_{workspace}"
    graph = client.select_graph(graph_name)
    return client, graph


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@app.get("/")
def home():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/status")
def status(request: Request):
    try:
        workspace = workspace_name(request)
        client, graph = graph_connection(workspace)
        graph.ro_query("RETURN 1 AS ready")
        client.close()
        base_graph = os.getenv("FALKORDB_GRAPH", "recallos_demo")
        return {"connected": True, "workspace": workspace,
                "graph": base_graph if workspace == "demo" else f"{base_graph}_{workspace}"}
    except Exception as exc:
        return {"connected": False, "error": str(exc), "graph": os.getenv("FALKORDB_GRAPH", "recallos_demo")}


@app.post("/api/seed")
def seed_demo(request: Request):
    """Add one synthetic example so a first-time judge can try recall immediately."""
    return save_memory(MemoryInput(
        project="Atlas Login",
        decision="Use passkeys as the primary sign-in method, with email fallback.",
        incident="The first rollout failed on older Android devices that lacked passkey support.",
        lesson="Check device compatibility before rollout and keep a tested fallback path.",
        agent="Planner Agent",
    ), request)


@app.post("/api/memories")
def save_memory(item: MemoryInput, request: Request):
    """Persist one connected episode; each API call gets unique, traceable IDs."""
    client, graph = graph_connection(workspace_name(request))
    stamp = now_iso()
    episode_id = str(uuid4())
    agent_id = str(uuid4())
    project_id = str(uuid4())
    decision_id = str(uuid4())
    incident_id = str(uuid4())
    lesson_id = str(uuid4())
    try:
        graph.query(
            """
            MERGE (p:Project {name: $project})
            CREATE (a:Agent {id: $agent_id, name: $agent})
            CREATE (s:Session {id: $episode_id, created_at: $created_at})
            CREATE (d:Decision {id: $decision_id, text: $decision, created_at: $created_at})
            CREATE (i:Incident {id: $incident_id, text: $incident, created_at: $created_at})
            CREATE (l:Lesson {id: $lesson_id, text: $lesson, created_at: $created_at})
            CREATE (a)-[:STARTED]->(s)
            CREATE (s)-[:RECORDED]->(d)
            CREATE (d)-[:FOR_PROJECT]->(p)
            CREATE (d)-[:LED_TO]->(i)
            CREATE (i)-[:PRODUCED]->(l)
            CREATE (l)-[:FOR_PROJECT]->(p)
            CREATE (a)-[:LEARNED]->(l)
            """,
            params={
                "project": item.project.strip(), "agent": item.agent.strip(),
                "agent_id": agent_id, "episode_id": episode_id,
                "decision_id": decision_id, "incident_id": incident_id,
                "lesson_id": lesson_id, "decision": item.decision.strip(),
                "incident": item.incident.strip(), "lesson": item.lesson.strip(),
                "created_at": stamp,
            },
        )
        return {"saved": True, "session_id": episode_id, "message": "Memory saved to FalkorDB."}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Could not save memory: {exc}") from exc
    finally:
        client.close()


@app.get("/api/recall")
def recall(request: Request, q: str = ""):
    """Retrieve lessons by walking the decision→incident→lesson graph path."""
    if not q.strip():
        raise HTTPException(status_code=400, detail="Enter a project name or keyword to recall.")
    client, graph = graph_connection(workspace_name(request))
    try:
        result = graph.ro_query(
            """
            MATCH (s:Session)-[:RECORDED]->(d:Decision)-[:FOR_PROJECT]->(p:Project),
                  (d)-[:LED_TO]->(i:Incident)-[:PRODUCED]->(l:Lesson)
            WHERE toLower(p.name) CONTAINS toLower($term)
               OR toLower(d.text) CONTAINS toLower($term)
               OR toLower(i.text) CONTAINS toLower($term)
               OR toLower(l.text) CONTAINS toLower($term)
            OPTIONAL MATCH (a:Agent)-[:STARTED]->(s)
            RETURN p.name AS project, d.text AS decision, i.text AS incident,
                   l.text AS lesson, a.name AS recorded_by, s.created_at AS created_at,
                   s.id AS session_id
            ORDER BY s.created_at DESC
            LIMIT 12
            """,
            params={"term": q.strip()},
        )
        # FalkorDB's Python client exposes headers as [column_name, type] pairs.
        # Use the column name as the dict key; the pair itself is a list and is
        # therefore not hashable.
        memories = [_row_dict(result, row) for row in result.result_set]
        return {"query": q, "count": len(memories), "memories": memories}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Could not query graph: {exc}") from exc
    finally:
        client.close()


@app.post("/api/handoffs")
def create_handoff(item: HandoffInput, request: Request):
    """Pass the latest lesson for a project from one agent role to another."""
    client, graph = graph_connection(workspace_name(request))
    handoff_id = str(uuid4())
    stamp = now_iso()
    try:
        lesson_result = graph.ro_query(
            """
            MATCH (l:Lesson)-[:FOR_PROJECT]->(p:Project {name: $project})
            RETURN l.id AS lesson_id
            ORDER BY l.created_at DESC
            LIMIT 1
            """,
            params={"project": item.project.strip()},
        )
        if not lesson_result.result_set:
            raise HTTPException(status_code=404, detail="No lesson found for that project in this workspace.")
        lesson_id = lesson_result.result_set[0][0]
        graph.query(
            """
            MATCH (p:Project {name: $project}), (l:Lesson {id: $lesson_id})
            MERGE (sender:AgentRole {name: $from_agent})
            MERGE (receiver:AgentRole {name: $to_agent})
            CREATE (h:Handoff {id: $handoff_id, task: $task, status: 'pending', created_at: $created_at})
            CREATE (sender)-[:HANDED_OFF]->(h)
            CREATE (h)-[:ASSIGNED_TO]->(receiver)
            CREATE (h)-[:CARRIES]->(l)
            CREATE (h)-[:FOR_PROJECT]->(p)
            """,
            params={"project": item.project.strip(), "lesson_id": lesson_id,
                    "from_agent": item.from_agent.strip(), "to_agent": item.to_agent.strip(),
                    "handoff_id": handoff_id, "task": item.task.strip(), "created_at": stamp},
        )
        return {"created": True, "handoff_id": handoff_id, "status": "pending",
                "message": f"Lesson handed from {item.from_agent} to {item.to_agent}."}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Could not create handoff: {exc}") from exc
    finally:
        client.close()


@app.get("/api/handoffs")
def list_handoffs(request: Request, agent: str = "Support Agent", status: str = "pending"):
    """List handoffs assigned to an agent in the selected workspace graph."""
    client, graph = graph_connection(workspace_name(request))
    try:
        result = graph.ro_query(
            """
            MATCH (sender:AgentRole)-[:HANDED_OFF]->(h:Handoff)-[:ASSIGNED_TO]->(receiver:AgentRole),
                  (h)-[:CARRIES]->(l:Lesson), (h)-[:FOR_PROJECT]->(p:Project)
            WHERE receiver.name = $agent AND h.status = $status
            RETURN h.id AS id, h.task AS task, h.status AS status, h.created_at AS created_at,
                   sender.name AS from_agent, receiver.name AS to_agent,
                   p.name AS project, l.text AS lesson
            ORDER BY h.created_at DESC
            LIMIT 20
            """,
            params={"agent": agent, "status": status},
        )
        return {"handoffs": [_row_dict(result, row) for row in result.result_set]}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Could not load handoffs: {exc}") from exc
    finally:
        client.close()


@app.post("/api/handoffs/{handoff_id}/complete")
def complete_handoff(handoff_id: str, request: Request):
    """Mark an assigned piece of work as completed in the same workspace graph."""
    client, graph = graph_connection(workspace_name(request))
    try:
        result = graph.query(
            """
            MATCH (h:Handoff {id: $id})
            SET h.status = 'completed', h.completed_at = $completed_at
            RETURN h.id AS id
            """,
            params={"id": handoff_id, "completed_at": now_iso()},
        )
        if not result.result_set:
            raise HTTPException(status_code=404, detail="Handoff not found in this workspace.")
        return {"completed": True, "handoff_id": handoff_id}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Could not complete handoff: {exc}") from exc
    finally:
        client.close()


@app.get("/api/graph")
def graph_snapshot(request: Request):
    """Return nodes and edges for the UI's SVG graph; edges come from FalkorDB."""
    client, graph = graph_connection(workspace_name(request))
    try:
        result = graph.ro_query(
            """
            MATCH (n)
            OPTIONAL MATCH (n)-[r]->(m)
            RETURN labels(n) AS labels, properties(n) AS props,
                   type(r) AS edge_type, labels(m) AS target_labels,
                   properties(m) AS target_props
            LIMIT 300
            """
        )
        nodes, edges, seen_edges = {}, [], set()
        for labels, props, edge_type, target_labels, target_props in result.result_set:
            source = _node_key(labels, props)
            nodes[source] = _node_view(source, labels, props)
            if edge_type and target_labels is not None:
                target = _node_key(target_labels, target_props)
                nodes[target] = _node_view(target, target_labels, target_props)
                edge_key = (source, target, edge_type)
                if edge_key not in seen_edges:
                    edges.append({"source": source, "target": target, "type": edge_type})
                    seen_edges.add(edge_key)
        return {"nodes": list(nodes.values()), "edges": edges}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Could not load graph: {exc}") from exc
    finally:
        client.close()


def _node_key(labels, props):
    label = labels[0] if labels else "Node"
    identity = props.get("id") or props.get("name") or props.get("created_at") or str(props)
    return f"{label}:{identity}"


def _node_view(key, labels, props):
    label = labels[0] if labels else "Node"
    title = props.get("name") or props.get("text") or label
    return {"id": key, "label": label, "title": str(title)[:88]}


def _row_dict(result, row):
    """Convert FalkorDB's (type, column name) headers into JSON key/value rows."""
    headers = []
    for column in result.header:
        if isinstance(column, (list, tuple)):
            names = [part for part in column if isinstance(part, str)]
            headers.append(names[-1] if names else column[0] if column else column)
        else:
            headers.append(column)
    return dict(zip(headers, row))


