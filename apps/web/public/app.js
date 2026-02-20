(function () {
  const logEl = document.getElementById("log");
  const btnConnect = document.getElementById("btn-connect");
  const btnSwap = document.getElementById("btn-swap");

  const statusNodes = {
    mode: document.getElementById("mode-val"),
    rpc: document.getElementById("rpc-val"),
    wallet: document.getElementById("wallet-val"),
    balance: document.getElementById("balance-val"),
    kill: document.getElementById("kill-val"),
    risk: document.getElementById("risk-val"),
    trades: document.getElementById("trades-val"),
    circuit: document.getElementById("circuit-val"),
    scanTime: document.getElementById("scan-time-val"),
    pools: document.getElementById("pools-val"),
    candidates: document.getElementById("candidates-val"),
    positions: document.getElementById("positions-list"),
  };

  function fmtNumber(value, digits = 4) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "0.0000";
    return n.toFixed(digits);
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
    while (logEl.childElementCount > 700) {
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

  function updateStatus(payload) {
    const system = payload.system || {};
    const scanner = payload.scanner || {};
    const risk = payload.risk || {};

    statusNodes.mode.textContent = String(payload.mode || system.mode || "PAPER").toUpperCase();
    statusNodes.mode.className = `stat-val ${payload.mode === "live" || system.mode === "live" ? "warn" : "ok"}`;

    const rpcOk = Boolean(system.rpcOk);
    statusNodes.rpc.textContent = rpcOk ? "OK" : `ERROR ${system.rpcError || ""}`.trim();
    statusNodes.rpc.className = `stat-val ${rpcOk ? "ok" : "err"}`;

    statusNodes.wallet.textContent = String(system.walletMasked || "N/A").toUpperCase();
    statusNodes.wallet.className = "stat-val hi";

    statusNodes.balance.textContent = `${fmtNumber(system.walletBalanceSol, 4)} SOL`;
    statusNodes.balance.className = "stat-val";

    const kill = Boolean(risk.killSwitchActive);
    statusNodes.kill.textContent = kill ? "ACTIVE" : "OFF";
    statusNodes.kill.className = `stat-val ${kill ? "err" : "ok"}`;

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
        `PNL ${fmtNumber(pnlPct, 2)}%`,
        `TP ${position.takeProfit1Pct}%/${position.takeProfit2Pct}%`,
        `SL -${position.stopLossPct}%`,
        `T-${fmtNumber(remaining, 1)}M`,
      ].join(" | ");

      row.appendChild(head);
      row.appendChild(meta);
      container.appendChild(row);
    });
  }

  async function fetchStatusAndPositions() {
    const [statusRes, positionsRes] = await Promise.all([fetch("/api/status"), fetch("/api/positions")]);
    if (statusRes.ok) {
      const payload = await statusRes.json();
      updateStatus(payload);
    }
    if (positionsRes.ok) {
      const payload = await positionsRes.json();
      renderPositions(payload.positions || []);
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

  async function init() {
    appendLog("===== BRANTSWAP TERMINAL BOOT =====", "hi");
    appendLog("CONNECTING STATUS BUS...", "dim");
    appendLog("CONNECTING LOG STREAM...", "dim");
    const lastId = await bootstrapLogs();
    await fetchStatusAndPositions();

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
      fetchStatusAndPositions().catch((error) => {
        appendLog(`ERROR STATUS FETCH ${String(error)}`, "err");
      });
    }, 5000);
  }

  btnConnect?.addEventListener("click", async () => {
    btnConnect.classList.add("pulse");
    appendLog("STEP CONNECT: STATUS REFRESH REQUESTED", "info");
    try {
      await fetchStatusAndPositions();
      appendLog("CONFIRMED: STATUS REFRESH COMPLETE", "ok");
    } catch (error) {
      appendLog(`ERROR: CONNECT FAILED ${String(error)}`, "err");
    } finally {
      btnConnect.classList.remove("pulse");
    }
  });

  btnSwap?.addEventListener("click", async () => {
    btnSwap.classList.add("pulse");
    appendLog("STEP EXECUTE: PING REQUESTED", "info");
    try {
      const res = await fetch("/api/ping");
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      appendLog("CONFIRMED: EXECUTE PING ONLINE", "ok");
    } catch (error) {
      appendLog(`ERROR: EXECUTE PING FAILED ${String(error)}`, "err");
    } finally {
      btnSwap.classList.remove("pulse");
    }
  });

  init().catch((error) => {
    appendLog(`ERROR BOOT ${String(error)}`, "err");
  });
})();
