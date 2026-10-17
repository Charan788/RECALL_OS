# RecallOS

A graph memory layer for agents that need to pick up work across sessions.

Most agent demos end when the conversation does. RecallOS lets one agent leave a useful record for the next: the decision, what happened afterward, and the lesson worth keeping. Those facts live in FalkorDB as connected nodes, so a later agent can search the project and follow the same path through the graph.

I built this for the Agent Memory and Coordination track at Graph Hacks. The demo is deliberately small: you can write an episode, inspect the graph, recall it in a fresh session, and pass its lesson to another agent.

## Try it locally

You’ll need Python 3.10 or newer and Docker Desktop (or another Docker Engine with Compose).

Start FalkorDB from the project folder:

```powershell
docker compose up -d
```

Create a virtual environment and install the app:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

Start the web app:

```powershell
uvicorn app:app --reload
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). The FalkorDB browser is at [http://localhost:3000](http://localhost:3000).

On macOS or Linux, use `python3 -m venv .venv` and `source .venv/bin/activate` for the environment steps. The remaining commands are the same.

To see the flow, load the Atlas Login demo memory, then search for `Atlas Login`. You can also save an episode of your own, create a handoff to Support Agent, and acknowledge it from the handoff list.

Stop the database with `docker compose down`. Its named volume keeps graph data between runs. To clear that local data, run `docker compose down -v`.

## What gets saved

Each memory is an episode with a decision, an incident, and a lesson. FalkorDB stores the episode as this graph:

```text
(Agent)-[:STARTED]->(Session)-[:RECORDED]->(Decision)-[:FOR_PROJECT]->(Project)
                                              |
                                              + -[:LED_TO]->(Incident)-[:PRODUCED]->(Lesson)
                                                                        ^             |
                                             (Agent)-[:LEARNED]---------+             + -[:FOR_PROJECT]->(Project)
```

The project node is shared by episodes with the same project name. The episode records get their own IDs, so later decisions and outcomes stay distinct.

A handoff links a task to the project and the latest lesson for that project:

```text
(AgentRole)-[:HANDED_OFF]->(Handoff)-[:ASSIGNED_TO]->(AgentRole)
                                ├-[:CARRIES]->(Lesson)
                                └-[:FOR_PROJECT]->(Project)
```

The receiving agent can see pending handoffs and mark one complete. Both the task and its status are stored in FalkorDB.

## How recall and the graph view work

Recall is a parameterized Cypher query. It looks for a keyword in the project, decision, incident, or lesson, then returns the connected episode and the agent who recorded it. The UI shows those stored records; it doesn’t ask a model to invent missing context.

The graph animation reads nodes and relationships from `/api/graph` and draws them on a canvas. Connected nodes pull together like springs, while unrelated nodes push apart and drift toward the center. You can drag nodes, select one to inspect its links, filter by node type, and highlight memories found by recall. The moving graph is a view of FalkorDB data, not a separate copy of the memory store.

## Workspaces

The selector switches between FalkorDB graphs. `Demo` uses `recallos_demo`; other selections use names such as `recallos_demo_team-alpha`. The choice is saved in the browser and sent with each request in the `X-Workspace` header.

This is graph-level separation for a prototype, not account security. There are no user accounts or access controls, so anyone who can reach the app can switch workspaces. Keep the demo on synthetic data unless you add authentication and authorization.

## API

| Method | Route | What it does |
| --- | --- | --- |
| `GET` | `/api/status` | Checks FalkorDB and reports the active graph. |
| `POST` | `/api/seed` | Writes the synthetic Atlas Login episode. |
| `POST` | `/api/memories` | Saves a decision, incident, and lesson as a connected episode. |
| `GET` | `/api/recall?q=Atlas` | Searches and returns matching connected memories. |
| `POST` | `/api/handoffs` | Creates a handoff carrying the latest project lesson. |
| `GET` | `/api/handoffs?agent=Support%20Agent&status=pending` | Lists handoffs assigned to an agent. |
| `POST` | `/api/handoffs/{id}/complete` | Marks a handoff complete. |
| `GET` | `/api/graph` | Returns the active graph’s nodes and relationships. |

FastAPI’s interactive API page is available at [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs).

## Configuration

The app reads its FalkorDB connection from `.env`:

| Variable | Default | Use |
| --- | --- | --- |
| `FALKORDB_HOST` | `localhost` | FalkorDB hostname. |
| `FALKORDB_PORT` | `6379` | FalkorDB port. |
| `FALKORDB_USERNAME` | empty | Username, if the server requires one. |
| `FALKORDB_PASSWORD` | empty | Password, if the server requires one. |
| `FALKORDB_GRAPH` | `recallos_demo` | Base graph name. |

For a hosted demo, run the FastAPI app somewhere it can reach FalkorDB Cloud or a secured FalkorDB instance, then set these values as environment secrets. Don’t commit `.env` or expose database credentials in the browser.

## Project files

```text
app.py                 FastAPI routes and FalkorDB queries
static/index.html      Page structure
static/style.css       Layout, typography, and motion
static/app.js          API calls and interactive graph
requirements.txt       Python dependencies
docker-compose.yml     Local FalkorDB service
.env.example           Local configuration template
```

## A couple of limits

RecallOS doesn’t currently connect to an LLM. Search is keyword matching in Cypher, which keeps the demo’s behavior direct and easy to inspect. It also doesn’t include authentication, production deployment settings, or safeguards for private data.

This prototype was built with help from OpenAI Codex. The graph model and queries are in the repo so they can be read and explained alongside the demo.
