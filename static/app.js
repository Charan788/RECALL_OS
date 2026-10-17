(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const workspacePicker = $('#workspace');
  const statusBox = $('#db-status');
  let graphData = { nodes: [], edges: [] };
  let heroGraph;
  let explorerGraph;
  let lastContext = '';

  function currentWorkspace() {
    return localStorage.getItem('recallos-workspace') || 'demo';
  }

  async function request(url, options = {}) {
    const headers = { ...(options.headers || {}), 'X-Workspace': currentWorkspace() };
    const response = await fetch(url, { ...options, headers });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Request failed');
    return data;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function updateStats(data) {
    const sessions = data.nodes.filter(node => node.label === 'Session').length;
    $('#hNodes').textContent = data.nodes.length;
    $('#hLinks').textContent = data.edges.length;
    $('#hSess').textContent = sessions;
    $('#pN').textContent = data.nodes.length;
    $('#pS').textContent = sessions;
    const agents = data.nodes.filter(node => node.label === 'Agent' || node.label === 'AgentRole').length;
    $('#hAgents').textContent = agents;
    $('#pAgents').textContent = agents;
    $('#api-node-count').textContent = data.nodes.length;
    $('#api-edge-count').textContent = data.edges.length;
    $('#api-memory-count').textContent = sessions;
  }

  async function checkStatus() {
    try {
      const status = await request('/api/status');
      statusBox.className = `db-status ${status.connected ? 'online' : 'offline'}`;
      statusBox.querySelector('span').textContent = status.connected
        ? `FalkorDB connected · ${status.workspace}` : 'FalkorDB offline';
      $('#graph-name').textContent = `graph: ${status.graph || 'unavailable'}`;
    } catch {
      statusBox.className = 'db-status offline';
      statusBox.querySelector('span').textContent = 'FalkorDB offline';
    }
  }

  async function refreshGraph() {
    try {
      graphData = await request('/api/graph');
      heroGraph?.setData(graphData);
      explorerGraph?.setData(graphData);
      updateStats(graphData);
      renderMemoryGallery(graphData);
      renderFilters(graphData.nodes);
      $('#graph-empty')?.classList.toggle('hidden', graphData.nodes.length > 0);
    } catch (error) {
      $('#hNodes').textContent = '—';
      $('#hLinks').textContent = '—';
      $('#hSess').textContent = '—';
      $('#memory-gallery').innerHTML = `<div class="hall-empty">${escapeHtml(error.message)}</div>`;
      $('#recall-results').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    }
  }

  function renderMemoryGallery({ nodes, edges }) {
    const gallery = $('#memory-gallery');
    const count = $('#hall-count');
    const byId = new Map(nodes.map(node => [node.id, node]));
    const decisions = nodes.filter(node => node.label === 'Decision').map(decision => {
      const projectEdge = edges.find(edge => edge.source === decision.id && edge.type === 'FOR_PROJECT');
      const incidentEdge = edges.find(edge => edge.source === decision.id && edge.type === 'LED_TO');
      const project = projectEdge ? byId.get(projectEdge.target) : null;
      const incident = incidentEdge ? byId.get(incidentEdge.target) : null;
      const lessonEdge = incident && edges.find(edge => edge.source === incident.id && edge.type === 'PRODUCED');
      const lesson = lessonEdge ? byId.get(lessonEdge.target) : null;
      return {
        project: project?.title || 'Unassigned project', decision: decision.title,
        incident: incident?.title || 'Outcome not recorded', lesson: lesson?.title || 'Lesson not recorded'
      };
    }).reverse();
    const unique = decisions.filter((episode, index, all) => all.findIndex(item =>
      item.project === episode.project && item.decision === episode.decision &&
      item.incident === episode.incident && item.lesson === episode.lesson
    ) === index).slice(0, 10);

    count.textContent = `${String(unique.length).padStart(2, '0')} ${unique.length === 1 ? 'MEMORY' : 'MEMORIES'} IN ARCHIVE`;
    if (!unique.length) {
      gallery.innerHTML = '<div class="hall-empty">No connected episodes yet. Record a memory to add its first graph path.</div>';
      return;
    }
    gallery.innerHTML = unique.map((episode, index) => `
      <button class="hall-card" type="button" data-project="${escapeHtml(episode.project)}">
        <span class="hall-art" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
        <span class="hall-card-copy"><span class="hall-project">${escapeHtml(episode.project)}</span>
        <span class="hall-decision">${escapeHtml(episode.decision)}</span>
        <span class="hall-incident"><i>OUTCOME</i>${escapeHtml(episode.incident)}</span>
        <span class="hall-lesson"><i>LESSON</i> ${escapeHtml(episode.lesson)}</span></span>
      </button>`).join('');
    gallery.querySelectorAll('.hall-card').forEach(card => card.addEventListener('click', () => {
      $('#archive-query').value = card.dataset.project;
      recall(card.dataset.project);
    }));
  }

  function renderFilters(nodes) {
    const chips = $('#chips');
    const labels = [...new Set(nodes.map(node => node.label))];
    const options = [['all', 'All types'], ...labels.map(label => [label, label])];
    const active = explorerGraph?.filterValue || 'all';
    chips.innerHTML = options.map(([value, title]) =>
      `<button class="chip${value === active ? ' on' : ''}" type="button" data-filter="${escapeHtml(value)}">${escapeHtml(title)}</button>`
    ).join('');
    chips.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
      const filter = button.dataset.filter === 'all' ? 'all' : button.dataset.filter;
      explorerGraph?.setFilter(filter);
      chips.querySelectorAll('.chip').forEach(chip => chip.classList.toggle('on', chip === button));
    }));
  }

  function showInspector(node) {
    const title = $('#iTitle');
    const body = $('#iBody');
    const tags = $('#iTags');
    const links = $('#iLinks');
    tags.replaceChildren();
    links.replaceChildren();
    if (!node) {
      title.textContent = 'Select a node';
      body.textContent = 'Choose a node to inspect its stored value and its direct graph connections.';
      return;
    }
    title.textContent = node.label;
    body.textContent = node.title;
    const adjacent = graphData.edges.filter(edge => edge.source === node.id || edge.target === node.id);
    const connected = new Set();
    adjacent.forEach(edge => {
      const otherId = edge.source === node.id ? edge.target : edge.source;
      const other = graphData.nodes.find(item => item.id === otherId);
      if (other) connected.add(other);
    });
    [...new Set([node.label, ...[...connected].map(item => item.label)])].slice(0, 5).forEach(label => {
      const tag = document.createElement('span');
      tag.textContent = label;
      tags.append(tag);
    });
    adjacent.slice(0, 5).forEach(edge => {
      const otherId = edge.source === node.id ? edge.target : edge.source;
      const other = graphData.nodes.find(item => item.id === otherId);
      if (!other) return;
      const row = document.createElement('div');
      const direction = edge.source === node.id ? '→' : '←';
      row.innerHTML = `<b>${escapeHtml(direction)} ${escapeHtml(edge.type)}</b> · ${escapeHtml(other.label)}: ${escapeHtml(other.title)}`;
      links.append(row);
    });
  }

  function renderRecall(data) {
    const results = $('#recall-results');
    if (!data.count) {
      results.innerHTML = '<div class="empty">No matching connected memories. Try another project or detail.</div>';
      return;
    }
    results.innerHTML = data.memories.map(memory => `
      <article class="result"><div class="result-top"><span>MEMORY FOUND · ${escapeHtml(memory.recorded_by || 'Agent')}</span><time>${escapeHtml((memory.created_at || '').slice(0, 10))}</time></div>
      <h4>${escapeHtml(memory.project)}</h4><p><b>Decision:</b> ${escapeHtml(memory.decision)}</p>
      <p><b>Incident:</b> ${escapeHtml(memory.incident)}</p><p><b>Lesson:</b> ${escapeHtml(memory.lesson)}</p></article>`).join('');
  }

  async function recall(query) {
    const term = query.trim();
    if (!term) {
      $('#recall-results').innerHTML = '<div class="empty">Enter a project name or detail to search the graph.</div>';
      $('#pack').classList.remove('show');
      explorerGraph?.setHighlight(null);
      return;
    }
    $('#recall-results').innerHTML = '<div class="empty">Following connected memories in FalkorDB…</div>';
    $('#pack').textContent = 'Querying the active workspace graph…';
    $('#pack').classList.add('show');
    try {
      const data = await request(`/api/recall?q=${encodeURIComponent(term)}`);
      renderRecall(data);
      lastContext = data.count
        ? `[RECALL_OS CONTEXT — ${data.count} connected ${data.count === 1 ? 'memory' : 'memories'} for "${term}"]\n` +
          data.memories.map(memory => `- ${memory.project} · ${memory.recorded_by || 'Agent'}\n  Decision: ${memory.decision}\n  Incident: ${memory.incident}\n  Lesson: ${memory.lesson}`).join('\n') + '\n[END CONTEXT]'
        : `No matching memories found for "${term}" in the active workspace.`;
      $('#pack').textContent = lastContext;
      explorerGraph?.setHighlight(findMatchingNodes(term));
    } catch (error) {
      $('#recall-results').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
      $('#pack').textContent = error.message;
      $('#pack').classList.add('show');
    }
  }

  function findMatchingNodes(query) {
    const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1);
    const matched = new Set();
    graphData.nodes.forEach(node => {
      const text = `${node.label} ${node.title}`.toLowerCase();
      if (tokens.some(token => text.includes(token))) matched.add(node.id);
    });
    graphData.edges.forEach(edge => {
      if (matched.has(edge.source) || matched.has(edge.target)) {
        matched.add(edge.source);
        matched.add(edge.target);
      }
    });
    return matched;
  }

  async function writeMemory(payload, endpoint = '/api/memories') {
    const message = $('#write-message');
    message.className = 'message';
    message.textContent = 'Saving connected memory to FalkorDB…';
    try {
      const data = await request(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: endpoint === '/api/seed' ? undefined : JSON.stringify(payload)
      });
      message.textContent = data.message;
      if (payload?.project) {
        $('#archive-query').value = payload.project;
        $('#q').value = payload.project;
        $('#handoff-form [name="project"]').value = payload.project;
      }
      await Promise.all([refreshGraph(), checkStatus()]);
      return true;
    } catch (error) {
      message.className = 'message error';
      message.textContent = error.message;
      return false;
    }
  }

  async function loadHandoffs() {
    const box = $('#handoff-results');
    const agent = $('#handoff-form [name="to_agent"]').value || 'Support Agent';
    $('#queue-title').textContent = `${agent}'s pending queue`;
    try {
      const data = await request(`/api/handoffs?agent=${encodeURIComponent(agent)}&status=pending`);
      if (!data.handoffs.length) {
        box.innerHTML = `<div class="empty">No pending handoffs for ${escapeHtml(agent)} in this workspace.</div>`;
        return;
      }
      box.innerHTML = data.handoffs.map(handoff => `
        <article class="handoff-item"><div><div class="result-top"><span>${escapeHtml(handoff.project)} · ${escapeHtml(handoff.from_agent)} → ${escapeHtml(handoff.to_agent)}</span><time>${escapeHtml((handoff.created_at || '').slice(0, 10))}</time></div>
        <p><b>Task:</b> ${escapeHtml(handoff.task)}</p><p><b>Carried lesson:</b> ${escapeHtml(handoff.lesson)}</p></div>
        <button type="button" data-complete-id="${escapeHtml(handoff.id)}">Acknowledge</button></article>`).join('');
      box.querySelectorAll('[data-complete-id]').forEach(button => button.addEventListener('click', () => completeHandoff(button.dataset.completeId)));
    } catch (error) {
      box.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    }
  }

  async function completeHandoff(id) {
    const message = $('#handoff-message');
    try {
      await request(`/api/handoffs/${encodeURIComponent(id)}/complete`, { method: 'POST' });
      message.className = 'message';
      message.textContent = 'Handoff acknowledged and marked complete in FalkorDB.';
      await Promise.all([loadHandoffs(), refreshGraph()]);
    } catch (error) {
      message.className = 'message error';
      message.textContent = error.message;
    }
  }

  class GraphCanvas {
    constructor(canvas, { interactive = false, decorative = false, onSelect = () => {} } = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.interactive = interactive;
      this.decorative = decorative;
      this.onSelect = onSelect;
      this.nodes = [];
      this.edges = [];
      this.highlight = null;
      this.filterValue = 'all';
      this.selected = null;
      this.hovered = null;
      this.pointer = { x: -999, y: -999, inside: false };
      this.dragging = null;
      this.frame = 0;
      this.width = 1;
      this.height = 1;
      this.dpr = 1;
      this.visible = true;
      this.resize();
      new ResizeObserver(() => this.resize()).observe(canvas);
      if ('IntersectionObserver' in window) {
        new IntersectionObserver(entries => {
          this.visible = entries[0].isIntersecting;
          if (this.visible) this.draw();
          else { cancelAnimationFrame(this.frame); this.frame = 0; }
        }).observe(canvas);
      }
      this.bindPointer();
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.draw(); });
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.width = Math.max(1, rect.width);
      this.height = Math.max(1, rect.height);
      this.canvas.width = Math.round(this.width * this.dpr);
      this.canvas.height = Math.round(this.height * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.nodes.forEach(node => {
        node.x = Math.min(this.width - 20, Math.max(20, node.x));
        node.y = Math.min(this.height - 20, Math.max(20, node.y));
      });
      this.draw();
    }

    setData(data) {
      const previous = new Map(this.nodes.map(node => [node.id, node]));
      const centerX = this.width / 2;
      const centerY = this.height / 2;
      const shape = label => ['Agent', 'AgentRole', 'Project'].includes(label) ? 'model'
        : ['Decision', 'Lesson'].includes(label) ? 'topic' : 'session';
      const radius = { model: 13, topic: 8, session: 5 };
      this.nodes = data.nodes.map((item, index) => {
        const old = previous.get(item.id);
        const angle = index * 2.399963229728653;
        const type = shape(item.label);
        return {
          ...item, t: type,
          x: old?.x ?? centerX + Math.cos(angle) * (60 + index * 6),
          y: old?.y ?? centerY + Math.sin(angle) * (60 + index * 6),
          vx: old?.vx ?? 0, vy: old?.vy ?? 0, r: radius[type]
        };
      });
      const byId = new Map(this.nodes.map(node => [node.id, node]));
      this.edges = data.edges.map(edge => ({ ...edge, a: byId.get(edge.source), b: byId.get(edge.target) }))
        .filter(edge => edge.a && edge.b);
      this.nodes.forEach(node => { node.nb = new Set(); });
      this.edges.forEach(edge => { edge.a.nb.add(edge.b.id); edge.b.nb.add(edge.a.id); });
      if (this.selected) this.selected = byId.get(this.selected.id) || null;
      this.draw();
    }

    bindPointer() {
      const point = event => {
        const rect = this.canvas.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top,
          inside: event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom };
      };
      const move = event => {
        if (event.pointerType === 'touch') return;
        const p = point(event);
        this.pointer = { x: p.x, y: p.y, inside: p.inside };
        if (this.dragging) {
          this.dragging.x = p.x;
          this.dragging.y = p.y;
        } else this.hovered = p.inside ? this.pick(p) : null;
        this.draw();
      };
      window.addEventListener('pointermove', move);
      this.canvas.addEventListener('pointerleave', () => {
        if (!this.dragging) { this.pointer.inside = false; this.hovered = null; }
      });
      this.canvas.addEventListener('pointerdown', event => {
        const p = point(event);
        const node = this.pick(p);
        if (!this.interactive) return;
        this.selected = node;
        this.dragging = node;
        if (node) this.canvas.setPointerCapture(event.pointerId);
        this.onSelect(node);
        this.draw();
      });
      this.canvas.addEventListener('pointerup', () => { this.dragging = null; });
      this.canvas.addEventListener('pointercancel', () => { this.dragging = null; });
    }

    pick(point) {
      let best = null;
      let distance = Infinity;
      this.nodes.forEach(node => {
        const d = Math.hypot(node.x - point.x, node.y - point.y);
        if (d < node.r + 10 && d < distance) { best = node; distance = d; }
      });
      return best;
    }

    setFilter(value) { this.filterValue = value; this.draw(); }
    setHighlight(value) { this.highlight = value; this.draw(); }
    select(node) { this.selected = node ? this.nodes.find(item => item.id === node.id) || null : null; this.draw(); }

    lit(node) {
      if (this.filterValue !== 'all' && node.label !== this.filterValue) return false;
      if (this.highlight) return this.highlight.has(node.id);
      if (this.selected) return node === this.selected || this.selected.nb.has(node.id);
      return true;
    }

    step() {
      const cx = this.width > 1000 ? this.width * (this.decorative ? .52 : .5) : this.width / 2;
      const cy = this.height / 2;
      for (let i = 0; i < this.nodes.length; i++) {
        const a = this.nodes[i];
        for (let j = i + 1; j < this.nodes.length; j++) {
          const b = this.nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distance2 = dx * dx + dy * dy + 30;
          if (distance2 > 90000) continue;
          const distance = Math.sqrt(distance2);
          const force = 2600 / distance2;
          a.vx += dx / distance * force;
          a.vy += dy / distance * force;
          b.vx -= dx / distance * force;
          b.vy -= dy / distance * force;
        }
        a.vx += (cx - a.x) * .0018;
        a.vy += (cy - a.y) * .0018;
        if (this.pointer.inside && a !== this.dragging) {
          const dx = a.x - this.pointer.x;
          const dy = a.y - this.pointer.y;
          const distance = Math.hypot(dx, dy);
          if (distance > .1 && distance < 150) {
            const push = (150 - distance) / 150 * 1.2;
            a.vx += dx / distance * push;
            a.vy += dy / distance * push;
          }
        }
      }
      this.edges.forEach(edge => {
        const dx = edge.b.x - edge.a.x;
        const dy = edge.b.y - edge.a.y;
        const distance = Math.hypot(dx, dy) || 1;
        const rest = (edge.a.t === 'session' && edge.b.t === 'model') || (edge.b.t === 'session' && edge.a.t === 'model') ? 105 : 78;
        const force = (distance - rest) * .012;
        const fx = dx / distance * force;
        const fy = dy / distance * force;
        edge.a.vx += fx;
        edge.a.vy += fy;
        edge.b.vx -= fx;
        edge.b.vy -= fy;
      });
      this.nodes.forEach(node => {
        if (node === this.dragging) { node.vx = 0; node.vy = 0; return; }
        node.vx *= .86;
        node.vy *= .86;
        node.x = Math.max(20, Math.min(this.width - 20, node.x + node.vx));
        node.y = Math.max(20, Math.min(this.height - 20, node.y + node.vy));
      });
    }

    draw() {
      if (!this.ctx || !this.visible || this.frame) return;
      this.frame = requestAnimationFrame(timestamp => {
        this.frame = 0;
        if (!reducedMotion && document.visibilityState === 'visible') this.step();
        this.paint();
        if (!reducedMotion && document.visibilityState === 'visible' && this.visible) this.draw();
      });
    }

    paint() {
      const ctx = this.ctx;
      const ink = this.decorative ? '#090a0b' : '#f7fafb';
      const line = this.decorative ? 'rgba(9,10,11,.18)' : 'rgba(255,255,255,.16)';
      const accent = '#02d2e3';
      const fill = this.decorative ? '#f7fafb' : '#090a0b';
      ctx.clearRect(0, 0, this.width, this.height);
      for (const edge of this.edges) {
        const on = this.lit(edge.a) && this.lit(edge.b);
        const emphasized = (this.selected && (edge.a === this.selected || edge.b === this.selected)) ||
          (this.highlight && this.highlight.has(edge.a.id) && this.highlight.has(edge.b.id));
        ctx.globalAlpha = on ? 1 : .25;
        ctx.strokeStyle = emphasized ? accent : line;
        ctx.lineWidth = emphasized ? 1.4 : 1;
        ctx.beginPath();
        ctx.moveTo(edge.a.x, edge.a.y);
        ctx.lineTo(edge.b.x, edge.b.y);
        ctx.stroke();
      }
      ctx.textBaseline = 'middle';
      ctx.font = '500 11px "Space Grotesk", sans-serif';
      for (const node of this.nodes) {
        const on = this.lit(node);
        ctx.globalAlpha = on ? 1 : .2;
        const hot = node === this.hovered || node === this.selected || Boolean(this.highlight && this.highlight.has(node.id));
        const near = this.pointer.inside && Math.hypot(node.x - this.pointer.x, node.y - this.pointer.y) < (this.decorative ? 130 : 0);
        if (hot || near) {
          const gradient = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, node.r * 4);
          gradient.addColorStop(0, 'rgba(2,210,227,.45)');
          gradient.addColorStop(1, 'rgba(2,210,227,0)');
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.r * 4, 0, Math.PI * 2);
          ctx.fill();
        }
        if (node.t === 'model') {
          ctx.fillStyle = hot ? accent : ink;
          ctx.fillRect(node.x - node.r, node.y - node.r, node.r * 2, node.r * 2);
        } else if (node.t === 'topic') {
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1.5;
          ctx.fillStyle = fill;
          ctx.beginPath();
          ctx.moveTo(node.x, node.y - node.r - 2);
          ctx.lineTo(node.x + node.r + 2, node.y);
          ctx.lineTo(node.x, node.y + node.r + 2);
          ctx.lineTo(node.x - node.r - 2, node.y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillStyle = hot || near ? accent : ink;
          ctx.globalAlpha = (on ? 1 : .2) * (hot || near ? 1 : .7);
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.r * (hot ? 1.4 : 1), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = on ? 1 : .2;
        if (node.t !== 'session' || hot || near) {
          ctx.fillStyle = node.t === 'topic' ? accent : ink;
          const text = node.t === 'session' ? node.title : (node.label.toUpperCase() + ' · ' + node.title);
          ctx.fillText(text.length > 42 ? text.slice(0, 39) + '…' : text, node.x + node.r + 8, node.y);
        }
      }
      ctx.globalAlpha = 1;
    }
  }
  function drawContours(canvas, color, alpha) {
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    let width = 1;
    let height = 1;
    let visible = true;
    let frame = 0;
    const start = performance.now();
    const fit = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint(0);
    };
    const field = (x, y, t) => {
      let value = Math.sin(x + t * .6) * .5;
      value += Math.sin(y * .85 - t * .45) * .45;
      value += Math.sin((x + y) * .65 + t * .35) * .35;
      value += Math.sin((x - y) * .95 - t * .55) * .25;
      return (value * .5 + .5) * 2.5;
    };
    const interpolate = (a, b, level) => Math.abs(b - a) < .0001 ? .5 : Math.max(0, Math.min(1, (level - a) / (b - a)));
    function paint(timestamp) {
      if (!visible || !width) return;
      const t = reducedMotion ? 0 : (performance.now() - start) / 1000 * 1.25;
      context.clearRect(0, 0, width, height);
      const columns = Math.max(24, Math.min(96, Math.round(width / 12)));
      const rows = Math.max(12, Math.round(columns * height / width));
      const sx = width / columns;
      const sy = height / rows;
      const values = new Float32Array((columns + 1) * (rows + 1));
      for (let j = 0; j <= rows; j++) for (let i = 0; i <= columns; i++) {
        const x = (i / columns * 2 - 1) * width / height * 3.8;
        const y = (j / rows * 2 - 1) * 3.8;
        values[j * (columns + 1) + i] = field(x + Math.sin(y * .8 + t * .7) * .37, y + Math.cos(x * .7 - t * .6) * .37, t);
      }
      context.strokeStyle = color;
      context.globalAlpha = alpha;
      context.lineWidth = 1;
      context.beginPath();
      const segment = (a, b) => { context.moveTo(a[0], a[1]); context.lineTo(b[0], b[1]); };
      for (let level = .65; level < 2.5; level += .7) for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) {
        const index = j * (columns + 1) + i;
        const a = values[index], b = values[index + 1], c = values[index + columns + 2], d = values[index + columns + 1];
        const code = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
        if (!code || code === 15) continue;
        const x = i * sx, y = j * sy;
        const top = [x + sx * interpolate(a, b, level), y];
        const right = [x + sx, y + sy * interpolate(b, c, level)];
        const bottom = [x + sx * interpolate(d, c, level), y + sy];
        const left = [x, y + sy * interpolate(a, d, level)];
        if ([1, 14].includes(code)) segment(left, bottom);
        else if ([2, 13].includes(code)) segment(bottom, right);
        else if ([3, 12].includes(code)) segment(left, right);
        else if ([4, 11].includes(code)) segment(top, right);
        else if ([6, 9].includes(code)) segment(top, bottom);
        else if ([7, 8].includes(code)) segment(left, top);
        else if (code === 5) { segment(left, top); segment(bottom, right); }
        else if (code === 10) { segment(left, bottom); segment(top, right); }
      }
      context.stroke();
      context.globalAlpha = 1;
      if (!reducedMotion && document.visibilityState === 'visible') frame = requestAnimationFrame(paint);
    }
    if ('IntersectionObserver' in window) new IntersectionObserver(entries => { visible = entries[0].isIntersecting; if (visible && !reducedMotion) paint(performance.now()); }).observe(canvas);
    new ResizeObserver(fit).observe(canvas);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && visible && !reducedMotion) paint(performance.now()); else cancelAnimationFrame(frame); });
    fit();
  }

  function initCtas() {
    $$('[data-cta]').forEach(anchor => {
      anchor.innerHTML = `<svg viewBox="0 0 220 50" preserveAspectRatio="none" aria-hidden="true">
        <path class="body" d="M220 42L212.932 50H0V0H220V42Z" fill="#0E0F14"/>
        <path class="flood" d="M220 42L212.932 50H0V0H220V42Z" fill="var(--accent)"/>
        <path d="M220 42L212.932 50H0V0H220V42Z" fill="none" stroke="var(--accent)" stroke-opacity=".25"/>
        <path d="M205 49.5H213L219.5 42V36M212 .5H219.5V7M8 .5H.5V7M7.5 49.5H.5V42.5" fill="none" stroke="var(--accent)"/></svg>
        <span>${escapeHtml(anchor.dataset.cta)}</span><em aria-hidden="true">→</em>`;
    });
  }

  $('#memory-form').addEventListener('submit', async event => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    await writeMemory(payload);
  });
  $('#seed-button').addEventListener('click', () => writeMemory(null, '/api/seed'));
  $('#recallBtn').addEventListener('click', () => recall($('#q').value));
  $('#archive-search').addEventListener('click', () => {
    $('#q').value = $('#archive-query').value;
    recall($('#archive-query').value);
  });
  $('#archive-query').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('#archive-search').click(); } });
  $('#q').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); recall(event.currentTarget.value); } });
  $('#copyBtn').addEventListener('click', async event => {
    if (!lastContext) await recall($('#q').value);
    try {
      await navigator.clipboard.writeText(lastContext || $('#pack').textContent);
      event.currentTarget.textContent = 'Copied';
      setTimeout(() => { event.currentTarget.textContent = 'Copy context'; }, 1300);
    } catch {
      $('#pack').focus?.();
    }
  });

  $('#handoff-form').addEventListener('submit', async event => {
    event.preventDefault();
    const message = $('#handoff-message');
    message.className = 'message';
    message.textContent = 'Creating connected handoff…';
    try {
      const payload = Object.fromEntries(new FormData(event.currentTarget));
      const data = await request('/api/handoffs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      message.textContent = data.message;
      await Promise.all([loadHandoffs(), refreshGraph()]);
    } catch (error) {
      message.className = 'message error';
      message.textContent = error.message;
    }
  });
  $('#refresh-handoffs').addEventListener('click', loadHandoffs);
  $('#handoff-form [name="to_agent"]').addEventListener('change', loadHandoffs);
  workspacePicker.value = currentWorkspace();
  workspacePicker.addEventListener('change', async () => {
    localStorage.setItem('recallos-workspace', workspacePicker.value);
    $('#recall-results').innerHTML = '<div class="empty">Search this workspace for a connected memory.</div>';
    await Promise.all([checkStatus(), refreshGraph(), loadHandoffs()]);
  });

  initCtas();
  heroGraph = new GraphCanvas($('#heroGraph'), { decorative: true });
  explorerGraph = new GraphCanvas($('#exGraph'), { interactive: true, onSelect: showInspector });
  drawContours($('[data-hero] canvas.bg'), '#dfe5e9', .85);
  drawContours($('#contA'), 'rgba(9,10,11,.08)', .85);
  drawContours($('#contMemory'), 'rgba(9,10,11,.08)', .85);
  drawContours($('#contB'), 'rgba(255,255,255,.1)', .85);
  Promise.all([checkStatus(), refreshGraph(), loadHandoffs()]);
})();
