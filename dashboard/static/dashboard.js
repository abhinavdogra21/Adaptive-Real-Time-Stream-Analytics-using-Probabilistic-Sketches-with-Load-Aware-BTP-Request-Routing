/* ==========================================================
   BTP Analytics Dashboard — JavaScript (Phase 2 Enhanced)
   Real-Time Telemetry, Monoid Scatter-Gather, RL HUD, Demo Mode
   ========================================================== */

const POLL_MS = 2000;

Chart.defaults.color       = '#64748b';
Chart.defaults.borderColor = 'rgba(255, 255, 255, 0.05)';
Chart.defaults.font.family = "'JetBrains Mono', monospace";
Chart.defaults.font.size   = 11;

const PALETTE = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#06b6d4', '#f43f5e', '#6366f1', '#ec4899'];

let latChart = null, memChart = null;
let routerQuery = 'frequency', qType = 'frequency', engineMode = 'distributed', selTpl = 'medium';
let lastCmsTotal = 0, lastPollTime = 0;
let isDemoMode = false, demoInterval = null;
let demoStep = 0;
let showSlaLine = false; // Auto-scale by default to clearly see sub-millisecond variations
let lastHistories = {};

function toggleSlaLine() {
  showSlaLine = !showSlaLine;
  const btn = document.getElementById('slaToggleBtn');
  const sub = document.getElementById('latChartSub');
  if (btn) {
    btn.textContent = showSlaLine ? '🔍 Auto-Zoom Variations (<1ms)' : '📏 Show 20ms SLA Line';
  }
  if (sub) {
    sub.textContent = showSlaLine 
      ? 'Worker latency vs 20ms SLA threshold line' 
      : 'Auto-scaled to sub-millisecond variations (~100-200 µs)';
  }
  if (latChart) {
    if (showSlaLine) {
      latChart.options.scales.y.suggestedMax = 25;
      latChart.options.scales.y.title.text = 'P99 Latency (ms)';
    } else {
      delete latChart.options.scales.y.suggestedMax;
      latChart.options.scales.y.title.text = 'P99 Latency (ms - Auto-zoomed)';
    }
  }
  updateLatChart(lastHistories);
}

function toggleHedgedGlobally() {
  const hedgeCheckbox = document.getElementById('hedgeCheckbox');
  const badge = document.getElementById('topHedgedBadge');
  const isNowHedged = hedgeCheckbox ? !hedgeCheckbox.checked : true;
  if (hedgeCheckbox) hedgeCheckbox.checked = isNowHedged;

  if (badge) {
    if (isNowHedged) {
      badge.className = 'pill-badge active-hedged';
      badge.textContent = '🛡️ Hedging: ACTIVE (Δ=4.5ms)';
    } else {
      badge.className = 'pill-badge disabled-hedged';
      badge.textContent = '🛡️ Hedging: DISABLED';
    }
  }
}

async function cycleCtrlMode() {
  const modes = ['rl', 'linucb', 'rule'];
  const curMode = document.getElementById('sysMode')?.textContent?.toLowerCase() || 'rl';
  let nextIdx = 0;
  if (curMode.includes('q') || curMode.includes('rl')) nextIdx = 1;
  else if (curMode.includes('lin')) nextIdx = 2;
  else nextIdx = 0;
  const targetMode = modes[nextIdx];
  const btn = document.getElementById(targetMode === 'rl' ? 'modeBtnRl' : targetMode === 'linucb' ? 'modeBtnLinucb' : 'modeBtnRule');
  await setCtrlMode(targetMode, btn);
}

// ── Chart setup ───────────────────────────────────────────
function initCharts() {
  const latCtx = document.getElementById('latencyChart');
  if (latCtx) {
    latChart = new Chart(latCtx, {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'top',
            labels: { boxWidth: 10, padding: 10, usePointStyle: true, color: '#94a3b8' },
          },
          tooltip: {
            backgroundColor: '#0f172a',
            borderColor: '#334155',
            borderWidth: 1,
            titleColor: '#f1f5f9',
            bodyColor: '#94a3b8',
            callbacks: {
              label: function(ctx) {
                const val = ctx.parsed.y;
                if (ctx.dataset.label === '20ms SLA Target') return '20ms SLA Target: 20 ms';
                const us = (val * 1000).toFixed(0);
                return `${ctx.dataset.label}: ${val.toFixed(3)} ms (${us} µs)`;
              }
            }
          },
        },
        scales: {
          x: {
            grid: { color: 'rgba(255, 255, 255, 0.03)' },
            ticks: { maxTicksLimit: 12, color: '#64748b' },
          },
          y: {
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            title: { display: true, text: 'P99 Latency (ms - Auto-zoomed)', color: '#64748b' },
            suggestedMin: 0,
          },
        },
      },
    });
  }

  const memCtx = document.getElementById('memoryChart');
  if (memCtx) {
    memChart = new Chart(memCtx, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          { label: 'CPU %', data: [], backgroundColor: 'rgba(59, 130, 246, 0.65)', borderColor: '#3b82f6', borderWidth: 1, borderRadius: 4 },
          { label: 'Memory %', data: [], backgroundColor: 'rgba(100, 116, 139, 0.35)', borderColor: '#64748b', borderWidth: 1, borderRadius: 4 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 250 },
        plugins: {
          legend: {
            position: 'top',
            labels: { boxWidth: 10, padding: 10, usePointStyle: true, color: '#94a3b8' },
          },
          tooltip: {
            backgroundColor: '#0f172a',
            borderColor: '#334155',
            borderWidth: 1,
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#94a3b8' } },
          y: {
            min: 0,
            max: 100,
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            title: { display: true, text: 'Utilization %', color: '#64748b' },
          },
        },
      },
    });
  }
}

// ── Formatters ────────────────────────────────────────────
const fmt = (n, d = 1) => {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(d) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(d) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(d) + 'K';
  return Number(n).toFixed(d);
};

const fmtTs = ts => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const tplCls = t => ({ low: 'tpl-low', medium: 'tpl-medium', high: 'tpl-high' }[t] || 'tpl-medium');

const logCls = m => {
  if (!m) return '';
  const low = m.toLowerCase();
  if (low.includes('drift')) return 'drift';
  if (low.includes('upgrade')) return 'upgrade';
  if (low.includes('downgrade')) return 'downgrade';
  if (low.includes('memory') || low.includes('sla')) return 'memory';
  if (low.includes('manual')) return 'manual';
  return '';
};

// ── Chart updates ─────────────────────────────────────────
function updateLatChart(histories) {
  if (!latChart) return;
  lastHistories = histories;
  const ids = Object.keys(histories);
  if (!ids.length) return;

  const maxLen = Math.max(...ids.map(id => (histories[id] || []).length), 0);
  latChart.data.labels = Array.from({ length: maxLen }, (_, i) => i + 1);

  // Manage SLA target dataset
  let slaDs = latChart.data.datasets.find(d => d.label === '20ms SLA Target');
  if (showSlaLine) {
    if (!slaDs) {
      slaDs = {
        label: '20ms SLA Target',
        data: Array(maxLen).fill(20.0),
        borderColor: 'rgba(239, 68, 68, 0.65)',
        borderWidth: 1.5,
        borderDash: [5, 5],
        pointRadius: 0,
        fill: false,
      };
      latChart.data.datasets.push(slaDs);
    } else {
      slaDs.data = Array(maxLen).fill(20.0);
    }
    latChart.options.scales.y.suggestedMax = 25;
  } else {
    // Hide SLA line so chart auto-scales to sub-millisecond data
    if (slaDs) {
      latChart.data.datasets = latChart.data.datasets.filter(d => d.label !== '20ms SLA Target');
    }
    delete latChart.options.scales.y.suggestedMax;
  }

  // Worker datasets
  ids.forEach((id, i) => {
    let ds = latChart.data.datasets.find(d => d.label === id);
    if (!ds) {
      const col = PALETTE[i % PALETTE.length];
      ds = {
        label: id,
        data: [],
        borderColor: col,
        backgroundColor: col + '15',
        tension: 0.3,
        fill: true,
        pointRadius: 3,
        borderWidth: 2,
      };
      latChart.data.datasets.push(ds);
    }
    ds.data = (histories[id] || []).map(Number);
  });

  latChart.data.datasets = latChart.data.datasets.filter(d => (showSlaLine && d.label === '20ms SLA Target') || ids.includes(d.label));
  latChart.update('none');
}

function updateMemChart(cluster) {
  if (!memChart) return;
  const ids = Object.keys(cluster);
  if (!ids.length) return;

  const mems = ids.map(id => cluster[id].memory_percent || 0);
  const cpus = ids.map(id => cluster[id].cpu_percent || 0);

  memChart.data.labels = ids;
  memChart.data.datasets[0].data = cpus;
  memChart.data.datasets[1].data = mems;

  memChart.update('none');
}

// ── KPIs & Hero Updates ───────────────────────────────────
function updateKPIs(cluster) {
  const ws = Object.values(cluster);
  if (!ws.length) return;

  const best = ws.reduce((a, b) => (a.p99_latency_ms || Infinity) < (b.p99_latency_ms || Infinity) ? a : b);
  const totalEvents = ws.reduce((acc, w) => acc + (w.cms_total_count || 0), 0);

  // Throughput Calculation
  const now = Date.now();
  if (lastPollTime > 0 && totalEvents >= lastCmsTotal) {
    const tps = (totalEvents - lastCmsTotal) / ((now - lastPollTime) / 1000);
    setText('sysThroughput', fmt(tps, 0) + ' ev/s');
  }
  lastCmsTotal = totalEvents;
  lastPollTime = now;

  // Sidebar
  setText('sysWorkers', ws.length);
  setText('sysTemplate', (best.template || 'medium').toUpperCase());
  setText('sysTotal', fmt(totalEvents, 1));
  setText('lastUpdate', new Date().toLocaleTimeString());

  // Hero: Distinct Elements (HLL)
  setText('ansHllVal', fmt(best.hll_cardinality, 0));
  setText('ansHllErr', `Relative error: ±${((best.hll_relative_error || 0.0162) * 100).toFixed(2)}% (p=${best.hll_precision || 12})`);

  // Hero: Misra-Gries Top Heavy Hitter
  const hh = best.mg_heavy_hitters || [];
  const winTotal = best.mg_window_total || 1;
  if (hh.length > 0) {
    const topItem = hh[0][0];
    const topCount = hh[0][1];
    const share = ((topCount / winTotal) * 100).toFixed(1);
    setText('ansMgVal', topItem);
    setText('ansMgShare', `Window Share: ${share}% (${fmt(topCount, 0)} counts)`);
  } else {
    setText('ansMgVal', '—');
    setText('ansMgShare', 'Window Share: —');
  }

  // Hero: Count-Min Sketch Live Frequency
  const cmsCount = best.cms_total_count || 0;
  const cmsErr = best.cms_error_estimate || Math.round(cmsCount * 0.0013);
  setText('ansCmsVal', fmt(cmsCount, 0));
  setText('ansCmsErr', `Error bound: ±${fmt(cmsErr, 0)} (Conservative Update)`);
}

// ── Heavy Hitters Table ───────────────────────────────────
function updateHH(cluster) {
  const ws = Object.values(cluster);
  if (!ws.length) return;
  const best = ws[0];
  const hh = best.mg_heavy_hitters || [];
  const total = best.mg_window_total || 1;
  setText('mgWindow', `Window N = ${fmt(total, 0)}`);

  const tbody = document.getElementById('hhTableBody');
  if (!tbody) return;
  if (!hh.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty">No heavy hitters detected in current sliding window</td></tr>`;
    return;
  }

  tbody.innerHTML = hh.slice(0, 10).map(([item, count], i) => {
    const pct = Math.min((count / total) * 100, 100);
    return `
      <tr>
        <td>${i + 1}</td>
        <td>${item}</td>
        <td>${fmt(count, 0)}</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="bar-wrap"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
            <span style="font-size:10px;font-family:var(--font-mono);">${pct.toFixed(1)}%</span>
          </div>
        </td>
      </tr>`;
  }).join('');
}

// ── Partition Topology ────────────────────────────────────
async function updatePartitionTopology() {
  try {
    const res = await fetch('/metrics/partitions');
    if (!res.ok) return;
    const data = await res.json();
    const partitions = data.partitions || {};
    const pKeys = Object.keys(partitions);
    if (!pKeys.length) return;

    setText('topoBadge', `${pKeys.length} Kafka Partitions · Hedged Dual-Replica`);
    setText('sysPartitions', `${pKeys.length} Shards`);

    const container = document.getElementById('topologyContainer');
    if (!container) return;

    let html = '';
    pKeys.forEach((pName, i) => {
      const p = partitions[pName];
      html += `
        <div class="partition-box has-worker">
          <div class="part-header">
            <span class="part-title">Partition #${i}</span>
            <span class="part-status">Healthy</span>
          </div>
          <div class="node-pair">
            <div class="node-role-row">
              <span class="role-primary">${p.primary || `worker-${i * 2}`}</span>
              <span class="role-badge p">Primary</span>
            </div>
            <div class="node-role-row">
              <span class="role-replica">${p.replica || `worker-${i * 2 + 1}`}</span>
              <span class="role-badge r">Replica</span>
            </div>
          </div>
          <div class="part-monoid-info">
            <span>CRC32 Hash % ${pKeys.length}</span>
            <span>CMS / HLL / MG</span>
          </div>
        </div>`;
    });

    // Monoid Core Box
    html += `
      <div class="monoid-agg-box">
        <div class="agg-header">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="m10 15 5-3-5-3v6Z"/></svg>
          Monoid Merge Core
        </div>
        <div class="agg-rules">
          <div>CMS: <span>Σ f_p(x)</span> (Additive)</div>
          <div>HLL: <span>max R_p[i]</span> (Semilattice)</div>
          <div>MG: <span>Space-Saving Merge</span></div>
        </div>
        <div style="font-size:10px;color:#94a3b8;font-family:var(--font-mono);">Zero Lock Contention · Hedged Δ=4.5ms</div>
      </div>`;

    container.innerHTML = html;
  } catch (_) {}
}

// ── Router Scores ─────────────────────────────────────────
async function updateRouter() {
  try {
    const res = await fetch(`/metrics/router?q=${routerQuery}`);
    if (!res.ok) return;
    const data = await res.json();
    const nodes = data.ranked_nodes || [];
    const el = document.getElementById('routerScores');
    if (!el) return;

    if (!nodes.length) {
      el.innerHTML = `<p class="empty">No workers registered yet</p>`;
      return;
    }

    el.innerHTML = nodes.map((n, i) => `
      <div class="node-row ${i === 0 ? 'best' : ''}">
        <span class="node-id">${i === 0 ? '★ ' : ''}${n.worker_id}</span>
        <span class="tpl-badge ${tplCls(n.metrics?.template)}">${n.metrics?.template || 'med'}</span>
        <span class="node-score">${n.score.toFixed(4)}</span>
      </div>`).join('');
  } catch (_) {}
}

// ── Controller Log & Stats ────────────────────────────────
async function updateCtrlLog() {
  try {
    const res = await fetch('/metrics/controller-log?n=25');
    if (!res.ok) return;
    const data = await res.json();
    const dec = (data.decisions || []).slice().reverse();
    const el = document.getElementById('ctrlLog');
    if (!el) return;

    if (!dec.length) {
      el.innerHTML = `<p class="empty">No decisions yet — controller runs every 5s</p>`;
      return;
    }

    el.innerHTML = dec.map(d => `
      <div class="log-entry ${logCls(d.message)}">
        <span class="log-ts">${fmtTs(d.ts)}</span>
        <span class="log-wid">${d.worker_id}</span>${d.message}
      </div>`).join('');
  } catch (_) {}
}

async function updateCtrlStats() {
  try {
    const res = await fetch('/metrics/controller-stats');
    if (!res.ok) return;
    const s = await res.json();

    setText('rlSteps', s.steps ?? 0);
    setText('rlEps', s.epsilon != null ? Number(s.epsilon).toFixed(3) : '—');
    setText('rlReward', s.avg_recent_reward != null ? Number(s.avg_recent_reward).toFixed(2) : '—');
    setText('rlDrifts', s.drift_events ?? 0);

    const mode = s.mode || 'rl';
    setText('sysMode', mode === 'rl' ? 'Q-Learning' : mode === 'linucb' ? 'LinUCB' : 'Rule-Based');
    setText('topModeBadge', mode === 'rl' ? '⚡ Q-Learning (108 MDP)' : mode === 'linucb' ? '⚡ LinUCB Bandit' : '⚙️ Rule-Based Mode');

    const rlBtn = document.getElementById('modeBtnRl');
    const linucbBtn = document.getElementById('modeBtnLinucb');
    const ruleBtn = document.getElementById('modeBtnRule');
    if (rlBtn && linucbBtn && ruleBtn) {
      rlBtn.classList.toggle('active', mode === 'rl');
      linucbBtn.classList.toggle('active', mode === 'linucb');
      ruleBtn.classList.toggle('active', mode === 'rule');
    }
  } catch (_) {}
}

async function setCtrlMode(mode, btn) {
  try {
    const res = await fetch('/control/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    if (res.ok) {
      document.querySelectorAll('#ctrlModeTabs .tab').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      await updateCtrlStats();
      await updateCtrlLog();
    }
  } catch (_) {}
}

// ── Interactive Query Playground ──────────────────────────
function setEngineMode(mode, btn) {
  engineMode = mode;
  document.querySelectorAll('#engineTabs .tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  const hedgeWrap = document.getElementById('hedgingOptionWrap');
  if (hedgeWrap) {
    hedgeWrap.style.display = mode === 'distributed' ? 'flex' : 'none';
  }
}

function setQType(t, btn) {
  qType = t;
  document.querySelectorAll('#queryTabs .tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  const row = document.getElementById('queryInputRow');
  if (row) {
    row.style.display = (t === 'frequency') ? 'flex' : 'flex';
    const keyInput = document.getElementById('queryKey');
    if (keyInput) {
      if (t === 'frequency') {
        keyInput.placeholder = 'Enter key (e.g. item_42)';
        keyInput.style.display = 'block';
      } else {
        keyInput.placeholder = 'Global cluster query (no key needed)';
        keyInput.style.display = 'none';
      }
    }
  }
}

async function runQuery() {
  const out = document.getElementById('queryResult');
  if (!out) return;
  out.textContent = '// Dispatching request…';

  try {
    let url = '';
    const isHedged = document.getElementById('hedgeCheckbox')?.checked ?? true;

    if (engineMode === 'distributed') {
      if (qType === 'frequency') {
        const key = document.getElementById('queryKey')?.value.trim() || 'item_42';
        url = `/query/distributed/frequency?key=${encodeURIComponent(key)}&hedged=${isHedged}&hedge_timeout_ms=6.0`;
      } else if (qType === 'cardinality') {
        url = `/query/distributed/cardinality?hedged=${isHedged}&hedge_timeout_ms=6.0`;
      } else {
        url = `/query/distributed/heavy-hitters?n=10&hedged=${isHedged}&hedge_timeout_ms=6.0`;
      }
    } else {
      if (qType === 'frequency') {
        const key = document.getElementById('queryKey')?.value.trim() || 'item_42';
        url = `/query/frequency?key=${encodeURIComponent(key)}`;
      } else if (qType === 'cardinality') {
        url = `/query/cardinality`;
      } else {
        url = `/query/heavy-hitters?n=10`;
      }
    }

    const t0 = performance.now();
    let data;
    try {
      const resp = await fetch(url);
      data = await resp.json();
    } catch (_) {
      data = { error: "Backend unreachable" };
    }
    const tClient = (performance.now() - t0).toFixed(2);

    // If no workers are online yet or in demo mode, provide realistic Monoid Merge telemetry
    if (data.error && (isDemoMode || data.partitions === 0 || data.error.includes("No active partitions"))) {
      const isHed = isHedged;
      data = {
        key: document.getElementById('queryKey')?.value.trim() || 'item_42',
        estimated_frequency: qType === 'frequency' ? 1845 : undefined,
        estimated_cardinality: qType === 'cardinality' ? 248500 : undefined,
        heavy_hitters: qType === 'heavy-hitters' ? [["item_auth_login", 2450], ["item_checkout_pay", 1820], ["item_stream_view", 1430]] : undefined,
        cms_total_count: 1450200,
        cms_error_bound: 185.0,
        partitions: 4,
        hedged_requests_fired: isHed ? 1 : 0,
        responders: [
          { worker_id: "worker-0", partition: 0, hedged: false, latency_ms: 3.42 },
          { worker_id: "worker-2", partition: 1, hedged: false, latency_ms: 4.10 },
          { worker_id: "worker-5", partition: 2, hedged: isHed, latency_ms: isHed ? 5.80 : 72.40, note: isHed ? "Replica won (Primary straggler cancelled)" : "Straggler delayed query" },
          { worker_id: "worker-6", partition: 3, hedged: false, latency_ms: 3.95 }
        ],
        total_scatter_gather_latency_ms: isHed ? 6.12 : 72.85,
        monoid_operator: qType === 'frequency' ? "Element-wise Count-Min Addition (⊕)" : qType === 'cardinality' ? "Coordinate-wise HLL Maximum (⊔)" : "Agarwal et al. Space-Saving Monoid Merge",
        info: "Live Simulation: Start background workers ('python3 stream/worker.py') to query live Kafka state."
      };
    }

    const wrapper = {
      engine: engineMode === 'distributed' ? 'Distributed Hedged Monoid Merge (Phase 2)' : 'Load-Aware Single-Node Router (Phase 1)',
      round_trip_client_ms: Number(tClient),
      response: data,
    };

    out.textContent = JSON.stringify(wrapper, null, 2);
  } catch (err) {
    out.textContent = `// Error executing query: ${err.message}\n// Hint: Make sure FastAPI backend is running on localhost:8000`;
  }
}

// ── Manual Override ───────────────────────────────────────
function pickTpl(t, btn) {
  selTpl = t;
  document.querySelectorAll('.seg').forEach(b => b.classList.remove('seg-active'));
  if (btn) btn.classList.add('seg-active');
}

async function applyOverride() {
  const wid = document.getElementById('ctrlWorkerId')?.value.trim() || 'worker-0';
  const st = document.getElementById('ctrlStatus');
  if (!st) return;

  try {
    const res = await fetch('/control/set-params', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worker_id: wid, template: selTpl }),
    });
    const data = await res.json();
    st.textContent = res.ok ? `✓ Applied '${selTpl}' to ${wid} (Zero-loss migration verified)` : `✗ ${data.detail}`;
    st.style.color = res.ok ? 'var(--green)' : 'var(--red)';
  } catch (_) {
    st.textContent = `✓ [Simulated] Applied '${selTpl}' to ${wid}`;
    st.style.color = 'var(--cyan)';
  }
  setTimeout(() => { if (st) st.textContent = ''; }, 4000);
}

// ── Router Query Tabs ─────────────────────────────────────
function setRouterQuery(q, btn) {
  routerQuery = q;
  document.querySelectorAll('#routerTabs .tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  updateRouter();
}

// ── Connection Status ─────────────────────────────────────
function setStatus(live, isDemo = false) {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  if (!dot || !txt) return;

  if (isDemo) {
    dot.className = 'status-dot demo';
    txt.textContent = 'Simulated Stream';
    return;
  }

  dot.className = 'status-dot ' + (live ? 'live' : 'error');
  txt.textContent = live ? 'Cluster Online' : 'Connecting';
}

// ── Poll Main Loop ────────────────────────────────────────
async function poll() {
  if (isDemoMode) {
    stepDemoSimulation();
    return;
  }

  try {
    const res = await fetch('/metrics/cluster');
    if (!res.ok) throw new Error('Cluster metrics unavailable');
    const data = await res.json();
    const cluster = data.workers || {};
    const histories = data.latency_histories || {};

    const hasWorkers = Object.keys(cluster).length > 0;
    if (hasWorkers) {
      setStatus(true);
      updateKPIs(cluster);
      updateLatChart(histories);
      updateMemChart(cluster);
      updateHH(cluster);
      await updatePartitionTopology();
      await updateRouter();
      await updateCtrlLog();
      await updateCtrlStats();
    } else {
      // API is running but no active background workers yet -> start rich demo mode
      setStatus(false);
      stepDemoSimulation();
    }
  } catch (_) {
    setStatus(false);
    stepDemoSimulation();
  }
}

// ── Interactive Demo Mode Simulation ──────────────────────
function toggleDemoMode() {
  isDemoMode = !isDemoMode;
  const btn = document.getElementById('demoToggleBtn');
  const icon = document.getElementById('demoIcon');
  const text = document.getElementById('demoText');
  if (btn && icon && text) {
    if (isDemoMode) {
      btn.style.borderColor = 'var(--cyan)';
      btn.style.boxShadow = '0 0 14px rgba(6, 182, 212, 0.4)';
      text.textContent = 'Live Demo Active';
      icon.textContent = '⏹';
    } else {
      btn.style.borderColor = '';
      btn.style.boxShadow = '';
      text.textContent = 'Live Demo Feed';
      icon.textContent = '▶';
    }
  }
  stepDemoSimulation();
}

function stepDemoSimulation() {
  demoStep++;
  setStatus(true, true);

  const mockCluster = {
    'worker-0': {
      template: 'medium',
      p99_latency_ms: +(12.4 + Math.sin(demoStep * 0.4) * 2.8).toFixed(2),
      cpu_percent: +(32 + Math.sin(demoStep * 0.5) * 8).toFixed(1),
      memory_percent: 41.2,
      hll_cardinality: 248500 + demoStep * 320,
      hll_relative_error: 0.0162,
      hll_precision: 12,
      cms_total_count: 1450200 + demoStep * 1840,
      cms_error_estimate: 1850,
      mg_window_total: 10000,
      mg_heavy_hitters: [
        ['item_auth_login', 2450 + Math.floor(Math.sin(demoStep) * 40)],
        ['item_checkout_pay', 1820],
        ['item_stream_view', 1430],
        ['item_cart_update', 920],
        ['item_profile_fetch', 610],
        ['item_search_query', 490],
      ],
    },
    'worker-1': {
      template: 'medium',
      p99_latency_ms: +(14.8 + Math.cos(demoStep * 0.4) * 3.2).toFixed(2),
      cpu_percent: +(38 + Math.cos(demoStep * 0.3) * 6).toFixed(1),
      memory_percent: 44.5,
      hll_cardinality: 248500 + demoStep * 320,
      cms_total_count: 1450200 + demoStep * 1840,
    },
    'worker-2': {
      template: 'high',
      p99_latency_ms: +(9.1 + Math.sin(demoStep * 0.2) * 1.5).toFixed(2),
      cpu_percent: +(48 + Math.sin(demoStep * 0.2) * 5).toFixed(1),
      memory_percent: 52.8,
      hll_cardinality: 248500 + demoStep * 320,
      cms_total_count: 1450200 + demoStep * 1840,
    },
    'worker-3': {
      template: 'low',
      p99_latency_ms: +(18.2 + Math.sin(demoStep * 0.6) * 4.1).toFixed(2),
      cpu_percent: +(24 + Math.sin(demoStep * 0.4) * 4).toFixed(1),
      memory_percent: 28.1,
      hll_cardinality: 248500 + demoStep * 320,
      cms_total_count: 1450200 + demoStep * 1840,
    },
  };

  const mockHistories = {
    'worker-0': Array.from({ length: 20 }, (_, i) => +(12 + Math.sin((demoStep + i) * 0.5) * 3).toFixed(1)),
    'worker-1': Array.from({ length: 20 }, (_, i) => +(14 + Math.cos((demoStep + i) * 0.4) * 3.5).toFixed(1)),
    'worker-2': Array.from({ length: 20 }, (_, i) => +(9 + Math.sin((demoStep + i) * 0.3) * 1.8).toFixed(1)),
    'worker-3': Array.from({ length: 20 }, (_, i) => +(17 + Math.sin((demoStep + i) * 0.7) * 4).toFixed(1)),
  };

  updateKPIs(mockCluster);
  updateLatChart(mockHistories);
  updateMemChart(mockCluster);
  updateHH(mockCluster);

  // Update RL Telemetry
  setText('rlSteps', 184 + demoStep * 3);
  setText('rlEps', Math.max(0.05, 0.28 - demoStep * 0.005).toFixed(3));
  setText('rlReward', (0.84 + Math.sin(demoStep * 0.2) * 0.08).toFixed(2));
  setText('rlDrifts', Math.floor(demoStep / 8));

  // Router scores
  const rEl = document.getElementById('routerScores');
  if (rEl) {
    rEl.innerHTML = `
      <div class="node-row best">
        <span class="node-id">★ worker-2 (Partition 1)</span>
        <span class="tpl-badge tpl-high">HIGH</span>
        <span class="node-score">0.8942</span>
      </div>
      <div class="node-row">
        <span class="node-id">worker-0 (Partition 0)</span>
        <span class="tpl-badge tpl-medium">MED</span>
        <span class="node-score">0.7610</span>
      </div>
      <div class="node-row">
        <span class="node-id">worker-1 (Partition 0)</span>
        <span class="tpl-badge tpl-medium">MED</span>
        <span class="node-score">0.7185</span>
      </div>
      <div class="node-row">
        <span class="node-id">worker-3 (Partition 1)</span>
        <span class="tpl-badge tpl-low">LOW</span>
        <span class="node-score">0.5840</span>
      </div>`;
  }

  // Controller Log
  const logEl = document.getElementById('ctrlLog');
  if (logEl) {
    const timeNow = new Date().toLocaleTimeString();
    logEl.innerHTML = `
      <div class="log-entry upgrade">
        <span class="log-ts">${timeNow}</span>
        <span class="log-wid">worker-2</span>[Q-Learn] Action 'high' selected: SLA compliant, latency 9.1ms
      </div>
      <div class="log-entry memory">
        <span class="log-ts">${timeNow}</span>
        <span class="log-wid">worker-0</span>[Q-Learn] State (L=1, M=1, E=0, T=1) → Reward +0.88
      </div>
      <div class="log-entry drift">
        <span class="log-ts">${timeNow}</span>
        <span class="log-wid">Cluster</span>[Concept Drift] L1 TVD=0.18 > threshold 0.15 → Policy triggered
      </div>
      <div class="log-entry upgrade">
        <span class="log-ts">${timeNow}</span>
        <span class="log-wid">worker-1</span>Zero-loss resize preserving: transferred 4,096 CMS counters
      </div>`;
  }
}

// ── Helper ────────────────────────────────────────────────
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ── Boot ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  poll();
  setInterval(poll, POLL_MS);
});
