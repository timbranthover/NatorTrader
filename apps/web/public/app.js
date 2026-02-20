(function () {
  const logEl = document.getElementById("log");
  const activityLogEl = document.getElementById("activity-log");
  const btnConnect = document.getElementById("btn-connect");
  const btnCopyWalletMini = document.getElementById("btn-copy-wallet-mini");
  const btnSwap = document.getElementById("btn-swap");

  const statusNodes = {
    mode: document.getElementById("mode-val"),
    rpc: document.getElementById("rpc-val"),
    wallet: document.getElementById("wallet-val"),
    walletHead: document.getElementById("wallet-head-val"),
    balance: document.getElementById("balance-val"),
    kill: document.getElementById("kill-val"),
    risk: document.getElementById("risk-val"),
    trades: document.getElementById("trades-val"),
    circuit: document.getElementById("circuit-val"),
    scanTime: document.getElementById("scan-time-val"),
    pools: document.getElementById("pools-val"),
    candidates: document.getElementById("candidates-val"),
    positions: document.getElementById("positions-list"),
    perfCounts: document.getElementById("perf-counts-val"),
    perfEntry: document.getElementById("perf-entry-val"),
    perfCurrent: document.getElementById("perf-current-val"),
    perfUnreal: document.getElementById("perf-unreal-val"),
    perfRealized: document.getElementById("perf-realized-val"),
    perfTotal: document.getElementById("perf-total-val"),
    perfWinrate: document.getElementById("perf-winrate-val"),
  };

  let killSwitchActive = false;
  let walletPubkeyCached = "";
  const PANEL_REFRESH_MS = 12000;
  const STATUS_FALLBACK_REFRESH_MS = 30000;
  let lastPositionsSig = "";
  let lastPerfSig = "";
  let lastActivitySig = "";
  let lastKnownMode = "paper";

  function fmtNumber(value, digits = 4) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "0.0000";
    return n.toFixed(digits);
  }

  function fmtSigned(value, digits = 4) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "0.0000";
    const sign = n > 0 ? "+" : "";
    return `${sign}${n.toFixed(digits)}`;
  }

  function classForLog(level) {
    if (level === "ERROR") return "err";
    if (level === "WARN") return "warn";
    if (level === "OK") return "ok";
    if (level === "DEBUG") return "dim";
    return "info";
  }

  function appendLog(text, klass) {
    if (!logEl) return;
    const line = document.createElement("div");
    line.className = `line ${klass || "info"}`;
    line.textContent = text;
    logEl.appendChild(line);
    while (logEl.childElementCount > 350) {
      logEl.removeChild(logEl.firstChild);
    }
    logEl.scrollTop = logEl.scrollHeight;
  }

  function formatTs(ts) {
    if (!ts) return "N/A";
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return "N/A";
    return date.toISOString().replace("T", " ").replace("Z", "Z");
  }

  function formatTsShort(ts) {
    if (!ts) return "N/A";
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return "N/A";
    return date.toISOString().slice(11, 19);
  }

  function updateKillButton() {
    if (!btnSwap) return;
    btnSwap.textContent = killSwitchActive ? "RESUME ENTRIES" : "HALT ENTRIES";
    btnSwap.classList.toggle("kill-active", killSwitchActive);
  }

  function updateStatus(payload) {
    const system = payload.system || {};
    const scanner = payload.scanner || {};
    const risk = payload.risk || {};
    lastKnownMode = String(payload.mode || system.mode || lastKnownMode).toLowerCase();

    statusNodes.mode.textContent = String(payload.mode || system.mode || "PAPER").toUpperCase();
    statusNodes.mode.className = `stat-val ${payload.mode === "live" || system.mode === "live" ? "warn" : "ok"}`;

    const rpcOk = Boolean(system.rpcOk);
    statusNodes.rpc.textContent = rpcOk ? "OK" : `ERROR ${system.rpcError || ""}`.trim();
    statusNodes.rpc.className = `stat-val ${rpcOk ? "ok" : "err"}`;

    const walletMasked = String(system.walletMasked || "N/A");
    const walletPubkey = String(system.walletPubkey || "N/A");
    walletPubkeyCached = walletPubkey;

    statusNodes.wallet.textContent = walletMasked;
    statusNodes.wallet.className = "stat-val hi";

    if (statusNodes.walletHead) {
      statusNodes.walletHead.textContent = walletPubkey;
      statusNodes.walletHead.className = walletPubkey !== "N/A" ? "wallet-head-val hi" : "wallet-head-val dim";
    }

    if (btnCopyWalletMini) {
      btnCopyWalletMini.disabled = walletPubkey === "N/A";
    }

    statusNodes.balance.textContent = `${fmtNumber(system.walletBalanceSol, 4)} SOL`;
    statusNodes.balance.className = "stat-val";

    killSwitchActive = Boolean(risk.killSwitchActive);
    statusNodes.kill.textContent = killSwitchActive ? "ACTIVE" : "OFF";
    statusNodes.kill.className = `stat-val ${killSwitchActive ? "err" : "ok"}`;
    updateKillButton();

    statusNodes.risk.textContent = `${fmtNumber(risk.atRiskSol, 4)} / ${fmtNumber(risk.maxSolAtRisk, 4)} SOL`;
    statusNodes.risk.className = "stat-val";

    statusNodes.trades.textContent = `${risk.tradesLastHour ?? 0} / ${risk.maxTradesPerHour ?? 0}`;
    statusNodes.trades.className = "stat-val";

    const circuitOpen = Boolean(risk.circuitOpen);
    statusNodes.circuit.textContent = circuitOpen ? "OPEN" : "CLOSED";
    statusNodes.circuit.className = `stat-val ${circuitOpen ? "err" : "ok"}`;

    statusNodes.scanTime.textContent = formatTs(scanner.lastScanTime);
    statusNodes.scanTime.className = "stat-val";

    statusNodes.pools.textContent = String(scanner.poolsSeenCount ?? 0);
    statusNodes.pools.className = "stat-val";

    statusNodes.candidates.textContent = String(scanner.candidatesCount ?? 0);
    statusNodes.candidates.className = "stat-val";
  }

  function updatePerformance(performance) {
    const perf = performance || {};
    statusNodes.perfCounts.textContent = `${perf.openPositions ?? 0} / ${perf.closedPositions ?? 0}`;
    statusNodes.perfCounts.className = "stat-val";

    statusNodes.perfEntry.textContent = `${fmtNumber(perf.openEntryExposureSol, 4)} SOL`;
    statusNodes.perfEntry.className = "stat-val";

    statusNodes.perfCurrent.textContent = `${fmtNumber(perf.openCurrentValueSol, 4)} SOL`;
    statusNodes.perfCurrent.className = "stat-val";

    const unrealized = Number(perf.unrealizedPnlSol ?? 0);
    const unrealizedPct = Number(perf.unrealizedPnlPct ?? 0);
    statusNodes.perfUnreal.textContent = `${fmtSigned(unrealized, 4)} SOL (${fmtSigned(unrealizedPct, 2)}%)`;
    statusNodes.perfUnreal.className = `stat-val ${unrealized >= 0 ? "ok" : "err"}`;

    const realized = Number(perf.realizedPnlSol ?? 0);
    statusNodes.perfRealized.textContent = `${fmtSigned(realized, 4)} SOL`;
    statusNodes.perfRealized.className = `stat-val ${realized >= 0 ? "ok" : "err"}`;

    const total = Number(perf.totalPnlSol ?? 0);
    const totalPct = Number(perf.totalPnlPct ?? 0);
    statusNodes.perfTotal.textContent = `${fmtSigned(total, 4)} SOL (${fmtSigned(totalPct, 2)}%)`;
    statusNodes.perfTotal.className = `stat-val ${total >= 0 ? "ok" : "err"}`;

    statusNodes.perfWinrate.textContent = `${fmtNumber(perf.winRatePct, 2)}%`;
    statusNodes.perfWinrate.className = "stat-val";
  }

  function renderPositions(positions) {
    const container = statusNodes.positions;
    if (!container) return;
    if (!positions || positions.length === 0) {
      container.className = "positions-empty";
      container.textContent = "NO ACTIVE POSITIONS";
      return;
    }

    container.className = "";
    container.innerHTML = "";
    const fragment = document.createDocumentFragment();

    positions.forEach((position) => {
      const row = document.createElement("div");
      row.className = "position-row";

      const head = document.createElement("div");
      head.className = "position-head";
      const mintLink = document.createElement("a");
      mintLink.className = "position-link hi";
      mintLink.href = `https://solscan.io/token/${position.tokenMint}`;
      mintLink.target = "_blank";
      mintLink.rel = "noopener noreferrer";
      mintLink.textContent = String(position.tokenMint);

      const notional = document.createElement("span");
      notional.textContent = `${fmtNumber(position.entryNotionalSol, 4)} SOL`;

      head.appendChild(mintLink);
      head.appendChild(notional);

      const currentQuote = Number(position.metadata?.currentValueSol || 0);
      const pnlPct = Number(position.metadata?.pnlPct || 0);
      const elapsedMinutes = Number(position.metadata?.elapsedMinutes || 0);
      const remaining = Math.max(0, Number(position.timeStopMinutes || 0) - elapsedMinutes);

      const meta = document.createElement("div");
      meta.className = "position-meta";
      meta.textContent = [
        `ENTRY ${fmtNumber(position.entryPriceSol, 8)} SOL/TKN`,
        `NOW ${fmtNumber(currentQuote, 4)} SOL`,
        `PNL ${fmtSigned(pnlPct, 2)}%`,
        `TP ${position.takeProfit1Pct}%/${position.takeProfit2Pct}%`,
        `SL -${position.stopLossPct}%`,
        `T-${fmtNumber(remaining, 1)}M`,
      ].join(" | ");

      row.appendChild(head);
      row.appendChild(meta);
      fragment.appendChild(row);
    });

    container.appendChild(fragment);
  }

  function activityClassForEvent(event) {
    if (event.status === "FAILED") return "activity-err";
    if (event.status === "PAPER_FILLED" || event.status === "PAPER_EXIT" || event.status === "CONFIRMED") return "activity-ok";
    return "activity-info";
  }

  function renderActivity(events) {
    if (!activityLogEl) return;
    activityLogEl.innerHTML = "";
    const items = events || [];
    if (items.length === 0) {
      const placeholder = document.createElement("div");
      placeholder.className = "line dim";
      placeholder.textContent = "NO TRADE ACTIVITY YET";
      activityLogEl.appendChild(placeholder);
      return;
    }

    const fragment = document.createDocumentFragment();
    items.forEach((event) => {
      const line = document.createElement("div");
      line.className = `line activity-line ${activityClassForEvent(event)}`;
      const tokenMint = event.side === "BUY" ? event.outputMint : event.inputMint;
      const sideAmountSol = event.side === "BUY"
        ? Number(event.inAmount) / 1_000_000_000
        : Number(event.outAmount || 0) / 1_000_000_000;
      const amountText = Number.isFinite(sideAmountSol) ? sideAmountSol.toFixed(4) : "0.0000";

      let text = `${formatTsShort(event.ts)} ${event.side} ${amountText} SOL ${event.side === "BUY" ? "->" : "<-"} ${tokenMint} [${event.status}]`;
      if (event.error) {
        text += ` ERROR=${event.error}`;
      }
      line.textContent = text;
      fragment.appendChild(line);
    });
    activityLogEl.appendChild(fragment);
    activityLogEl.scrollTop = activityLogEl.scrollHeight;
  }

  function stableSignature(value) {
    try {
      return JSON.stringify(value ?? null);
    } catch {
      return String(Date.now());
    }
  }

  async function fetchStatusOnly() {
    const statusRes = await fetch("/api/status");

    if (statusRes.ok) {
      const payload = await statusRes.json();
      updateStatus(payload);
    }
  }

  async function fetchDashboardOnly() {
    const dashboardRes = await fetch("/api/dashboard?limit=80");
    if (!dashboardRes.ok) {
      return;
    }
    const payload = await dashboardRes.json();
    const positions = payload.positions || [];
    const performance = payload.performance || {};
    const events = payload.events || [];

    const positionsSig = stableSignature(positions);
    if (positionsSig !== lastPositionsSig) {
      renderPositions(positions);
      lastPositionsSig = positionsSig;
    }

    const perfSig = stableSignature(performance);
    if (perfSig !== lastPerfSig) {
      updatePerformance(performance);
      lastPerfSig = perfSig;
    }

    const activitySig = stableSignature(events);
    if (activitySig !== lastActivitySig) {
      renderActivity(events);
      lastActivitySig = activitySig;
    }
  }

  async function fetchStatusAndPanels() {
    await Promise.all([fetchStatusOnly(), fetchDashboardOnly()]);
  }

  async function bootstrapLogs() {
    const res = await fetch("/api/logs");
    if (!res.ok) return 0;
    const payload = await res.json();
    let lastId = 0;
    (payload.logs || []).forEach((entry) => {
      lastId = entry.id;
      appendLog(`[${entry.ts}] ${entry.code} ${entry.message}`, classForLog(entry.level));
    });
    return lastId;
  }

  async function toggleKillSwitch() {
    const nextState = !killSwitchActive;
    const label = nextState ? "HALT ENTRIES" : "RESUME ENTRIES";
    appendLog(`STEP ${label}: REQUESTED`, "warn");
    const res = await fetch("/api/kill-switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: nextState }),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const payload = await res.json();
    killSwitchActive = Boolean(payload.active);
    updateKillButton();
    appendLog(
      killSwitchActive ? "WARNING: KILL SWITCH ACTIVE (NEW ENTRIES HALTED)" : "CONFIRMED: KILL SWITCH CLEARED",
      killSwitchActive ? "warn" : "ok",
    );
  }

  async function init() {
    appendLog("===== BRANTSWAP TERMINAL BOOT =====", "hi");
    appendLog("CONNECTING STATUS BUS...", "dim");
    appendLog("CONNECTING LOG STREAM...", "dim");
    const lastId = await bootstrapLogs();
    await fetchStatusAndPanels();

    const source = new EventSource(`/events/logs?lastId=${lastId}`);
    source.addEventListener("log", (event) => {
      try {
        const entry = JSON.parse(event.data);
        appendLog(`[${entry.ts}] ${entry.code} ${entry.message}`, classForLog(entry.level));
      } catch (error) {
        appendLog(`ERROR PARSING LOG EVENT ${String(error)}`, "err");
      }
    });
    source.addEventListener("status", (event) => {
      try {
        const payload = JSON.parse(event.data);
        updateStatus({ ...payload, mode: payload.system?.mode || lastKnownMode });
      } catch {
        // ignored
      }
    });
    source.onerror = () => {
      appendLog("WARNING LOG STREAM INTERRUPTED", "warn");
    };

    setInterval(() => {
      fetchDashboardOnly().catch((error) => {
        appendLog(`ERROR DASHBOARD FETCH ${String(error)}`, "err");
      });
    }, PANEL_REFRESH_MS);

    setInterval(() => {
      fetchStatusOnly().catch((error) => {
        appendLog(`ERROR STATUS FETCH ${String(error)}`, "err");
      });
    }, STATUS_FALLBACK_REFRESH_MS);
  }

  btnConnect?.addEventListener("click", async () => {
    btnConnect.classList.add("pulse");
    appendLog("STEP REFRESH: STATUS+PERFORMANCE REQUESTED", "info");
    try {
      await fetchStatusAndPanels();
      appendLog("CONFIRMED: PANEL REFRESH COMPLETE", "ok");
    } catch (error) {
      appendLog(`ERROR: REFRESH FAILED ${String(error)}`, "err");
    } finally {
      btnConnect.classList.remove("pulse");
    }
  });

  btnSwap?.addEventListener("click", async () => {
    btnSwap.classList.add("pulse");
    try {
      await toggleKillSwitch();
      await fetchStatusAndPanels();
    } catch (error) {
      appendLog(`ERROR: KILL SWITCH UPDATE FAILED ${String(error)}`, "err");
    } finally {
      btnSwap.classList.remove("pulse");
    }
  });

  btnCopyWalletMini?.addEventListener("click", async () => {
    const value = walletPubkeyCached;
    if (!value || value === "N/A") {
      appendLog("WARNING: WALLET ADDRESS UNAVAILABLE", "warn");
      return;
    }

    btnCopyWalletMini.classList.add("pulse");
    try {
      await navigator.clipboard.writeText(value);
      appendLog(`CONFIRMED: WALLET COPIED ${value}`, "ok");
    } catch (error) {
      appendLog(`ERROR: WALLET COPY FAILED ${String(error)}`, "err");
    } finally {
      btnCopyWalletMini.classList.remove("pulse");
    }
  });

  init().catch((error) => {
    appendLog(`ERROR BOOT ${String(error)}`, "err");
  });
})();
