(function () {
  const logEl = document.getElementById("log");
  const activityLogEl = document.getElementById("activity-log");
  const btnConnect = document.getElementById("btn-connect");
  const btnCopyWallet = document.getElementById("btn-copy-wallet");
  const btnSwap = document.getElementById("btn-swap");

  const statusNodes = {
    mode: document.getElementById("mode-val"),
    rpc: document.getElementById("rpc-val"),
    wallet: document.getElementById("wallet-val"),
    walletFull: document.getElementById("wallet-full-val"),
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
    while (logEl.childElementCount > 600) {
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

    if (statusNodes.walletFull) {
      statusNodes.walletFull.textContent = walletPubkey;
      statusNodes.walletFull.className = walletPubkey !== "N/A" ? "wallet-full hi" : "wallet-full dim";
    }

    if (btnCopyWallet) {
      btnCopyWallet.disabled = walletPubkey === "N/A";
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
      meta.innerHTML = [
        `ENTRY ${fmtNumber(position.entryPriceSol, 8)} SOL/TKN`,
        `NOW ${fmtNumber(currentQuote, 4)} SOL`,
        `PNL ${fmtSigned(pnlPct, 2)}%`,
        `TP ${position.takeProfit1Pct}%/${position.takeProfit2Pct}%`,
        `SL -${position.stopLossPct}%`,
        `T-${fmtNumber(remaining, 1)}M`,
      ].join(" | ");

      row.appendChild(head);
      row.appendChild(meta);
      container.appendChild(row);
    });
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
      activityLogEl.appendChild(line);
    });
    activityLogEl.scrollTop = activityLogEl.scrollHeight;
  }

  async function fetchStatusAndPanels() {
    const [statusRes, positionsRes, perfRes, activityRes] = await Promise.all([
      fetch("/api/status"),
      fetch("/api/positions"),
      fetch("/api/performance"),
      fetch("/api/activity?limit=120"),
    ]);

    if (statusRes.ok) {
      const payload = await statusRes.json();
      updateStatus(payload);
    }

    if (positionsRes.ok) {
      const payload = await positionsRes.json();
      renderPositions(payload.positions || []);
    }

    if (perfRes.ok) {
      const payload = await perfRes.json();
      updatePerformance(payload.performance || {});
    }

    if (activityRes.ok) {
      const payload = await activityRes.json();
      renderActivity(payload.events || []);
    }
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
        updateStatus({ ...payload, mode: payload.system?.mode || String(statusNodes.mode.textContent).toLowerCase() });
      } catch {
        // ignored
      }
    });
    source.onerror = () => {
      appendLog("WARNING LOG STREAM INTERRUPTED", "warn");
    };

    setInterval(() => {
      fetchStatusAndPanels().catch((error) => {
        appendLog(`ERROR STATUS FETCH ${String(error)}`, "err");
      });
    }, 5000);
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

  btnCopyWallet?.addEventListener("click", async () => {
    const value = walletPubkeyCached;
    if (!value || value === "N/A") {
      appendLog("WARNING: WALLET ADDRESS UNAVAILABLE", "warn");
      return;
    }

    btnCopyWallet.classList.add("pulse");
    try {
      await navigator.clipboard.writeText(value);
      appendLog(`CONFIRMED: WALLET COPIED ${value}`, "ok");
    } catch (error) {
      appendLog(`ERROR: WALLET COPY FAILED ${String(error)}`, "err");
    } finally {
      btnCopyWallet.classList.remove("pulse");
    }
  });

  init().catch((error) => {
    appendLog(`ERROR BOOT ${String(error)}`, "err");
  });
})();
