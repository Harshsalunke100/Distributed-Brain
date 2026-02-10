import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "http://192.168.1.62:3000";

function App() {
  const [page, setPage] = useState("auth");
  const [mode, setMode] = useState("register");
  const [formData, setFormData] = useState({ username: "", password: "" });

  const workerSocketRef = useRef(null);
  const userSocketRef = useRef(null);

  const [networkWorkers, setNetworkWorkers] = useState([]);

  const [workerConnected, setWorkerConnected] = useState(false);
  const [workerId, setWorkerId] = useState("");
  const [workerRoomType, setWorkerRoomType] = useState("public");
  const [workerRoomInput, setWorkerRoomInput] = useState("TEAM-A");
  const [workerReconnectKey, setWorkerReconnectKey] = useState(0);

  const [isParticipating, setIsParticipating] = useState(true);
  const [brainState, setBrainState] = useState("idle");
  const [gpuUtilization, setGpuUtilization] = useState(0);
  const [tasksSolved, setTasksSolved] = useState(0);
  const [computeTime, setComputeTime] = useState(0);
  const [transferTime, setTransferTime] = useState(0);
  const [brainEarnings, setBrainEarnings] = useState(0);

  const [requestConnected, setRequestConnected] = useState(false);
  const [requestMode, setRequestMode] = useState("ai");
  const [requestDimension, setRequestDimension] = useState("512");
  const [requestDisease, setRequestDisease] = useState("Alzheimers");
  const [requestTargetType, setRequestTargetType] = useState("public");
  const [requestRoom, setRequestRoom] = useState("public");
  const [requestPrivateCode, setRequestPrivateCode] = useState("");
  const [requestStatus, setRequestStatus] = useState("System idle. Ready to deploy.");
  const [resultPreview, setResultPreview] = useState("");
  const [lastSubmittedMode, setLastSubmittedMode] = useState("ai");

  const [adminConnected, setAdminConnected] = useState(false);
  const [adminLogs, setAdminLogs] = useState([]);

  const workerRoomId = useMemo(() => {
    if (workerRoomType === "private") {
      return workerRoomInput.trim() || "public";
    }
    return "public";
  }, [workerRoomInput, workerRoomType]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleAuthSubmit = (e) => {
    e.preventDefault();
    if (mode === "register") {
      console.log("Register payload:", formData);
      return;
    }
    console.log("Login payload:", formData);
    setPage("role");
  };

  const renderSiteTitle = () => (
    <h1 className="site-title">
      <span className="site-logo" aria-hidden="true">
        <svg viewBox="0 0 64 64" role="img" aria-hidden="true">
          <circle cx="32" cy="32" r="24" />
          <path d="M32 8 C22 10 22 54 32 56" />
          <path d="M32 8 C42 10 42 54 32 56" />
          <path d="M8 32h48" />
          <path d="M14 22 C23 28 41 28 50 22" />
          <path d="M14 42 C23 36 41 36 50 42" />
        </svg>
      </span>
      <span className="site-title-text">Distributed Brain</span>
    </h1>
  );

  const runWorkerCompute = (payload) => {
    const startedAt = performance.now();

    const dimension = Math.max(2, Number(payload.dimension) || 64);
    const rowCount = Math.max(1, Number(payload.rowCount) || dimension);
    const matrixA = Array.isArray(payload.matrixA) ? payload.matrixA : [];
    const matrixB = Array.isArray(payload.matrixB) ? payload.matrixB : [];

    // Generate full chunk result size for server aggregation.
    const outputLength = rowCount * dimension;
    const inner = Math.min(dimension, 24);
    const result = new Array(outputLength);

    for (let idx = 0; idx < outputLength; idx += 1) {
      const row = Math.floor(idx / dimension) % rowCount;
      const col = idx % dimension;
      let sum = 0;
      for (let k = 0; k < inner; k += 1) {
        const a = Number(matrixA[row * dimension + k] || 0);
        const b = Number(matrixB[k * dimension + col] || 0);
        sum += a * b;
      }
      result[idx] = Number(sum.toFixed(6));
    }

    const endedAt = performance.now();
    return {
      result,
      computeMs: Math.max(1, Math.round(endedAt - startedAt)),
      transferMs: Math.max(1, Math.round((matrixA.length + matrixB.length) / 2000)),
      gpuLoad: Math.min(98, 55 + Math.floor(Math.random() * 40)),
    };
  };

  useEffect(() => {
    if (page !== "donator" || !isParticipating) {
      setBrainState(isParticipating ? "idle" : "disconnected");
      return undefined;
    }

    const socket = io(SOCKET_URL);
    workerSocketRef.current = socket;

    socket.on("connect", () => {
      setWorkerConnected(true);
      setWorkerId(socket.id);
      socket.emit("register-worker", {
        hasWebGPU: true,
        gpuName: "WebGPU Adapter (Standard)",
        roomId: workerRoomId,
      });
      setBrainState("idle");
    });

    socket.on("disconnect", () => {
      setWorkerConnected(false);
      setBrainState("disconnected");
    });

    socket.on("network-status", (workers = []) => {
      setNetworkWorkers(workers);
    });

    socket.on("compute-task", (payload = {}) => {
      setBrainState("computing");
      const { result, computeMs, transferMs, gpuLoad } = runWorkerCompute(payload);

      setComputeTime(computeMs);
      setTransferTime(transferMs);
      setGpuUtilization(gpuLoad);
      setTasksSolved((prev) => prev + 1);
      setBrainEarnings((prev) => Number((prev + 0.42).toFixed(2)));

      socket.emit("compute-result", {
        jobId: payload.jobId,
        chunkId: payload.chunkId,
        result,
        computeTimeMs: computeMs,
        from: payload.from,
      });
      setTimeout(() => setBrainState("idle"), 300);
    });

    return () => {
      socket.disconnect();
      workerSocketRef.current = null;
    };
  }, [isParticipating, page, workerReconnectKey, workerRoomId]);

  useEffect(() => {
    if (page !== "requestor") return undefined;

    const socket = io(SOCKET_URL);
    userSocketRef.current = socket;

    socket.on("connect", () => setRequestConnected(true));
    socket.on("disconnect", () => setRequestConnected(false));
    socket.on("network-status", (workers = []) => setNetworkWorkers(workers));

    socket.on("job-status", (msg = {}) => {
      if (msg.status === "Assigned") {
        setRequestStatus(msg.msg || `Assigned to Worker: ${String(msg.worker || "").slice(0, 6)}...`);
      } else {
        setRequestStatus(msg.msg || "Queued. Waiting for worker...");
      }
    });

    socket.on("job-finished", (result = []) => {
      if (lastSubmittedMode === "science") {
        const raw = Number(Array.isArray(result) && result.length ? result[0] : 50);
        const energy = (-1 * (Math.abs(raw % 100) + 20)).toFixed(2);
        setRequestStatus(`Structure Stabilized. Free Energy: ${energy} kcal/mol`);
        setResultPreview("");
        return;
      }

      const preview = Array.isArray(result)
        ? result
            .slice(0, 3)
            .map((n) => Number(n).toFixed(2))
            .join(", ")
        : "";

      setRequestStatus(`Training Complete. Computed ${Array.isArray(result) ? result.length : 0} parameters.`);
      setResultPreview(preview ? `[${preview}...]` : "");
    });

    return () => {
      socket.disconnect();
      userSocketRef.current = null;
    };
  }, [lastSubmittedMode, page]);

  useEffect(() => {
    if (page !== "server") return undefined;

    const socket = io(SOCKET_URL);

    socket.on("connect", () => {
      setAdminConnected(true);
      socket.emit("register-admin");
    });

    socket.on("disconnect", () => setAdminConnected(false));
    socket.on("network-status", (workers = []) => setNetworkWorkers(workers));
    socket.on("admin-activity", (item) => {
      if (!item) return;
      setAdminLogs((prev) => [item, ...prev].slice(0, 50));
    });

    return () => socket.disconnect();
  }, [page]);

  const launchRequestTask = () => {
    const socket = userSocketRef.current;
    if (!socket || !socket.connected) {
      setRequestStatus("Not connected to server.");
      return;
    }

    const roomId =
      requestTargetType === "private"
        ? requestPrivateCode.trim()
        : requestRoom.trim() || "public";

    if (!roomId) {
      setRequestStatus("Enter private room code to connect to a private donor.");
      return;
    }
    const dimension = Math.max(16, Number.parseInt(requestDimension, 10) || 512);
    const size = dimension * dimension;

    const matrixA = Array.from({ length: size }, () => Math.random());
    const matrixB = Array.from({ length: size }, () => Math.random());

    if (requestMode === "science") {
      setRequestStatus(`Synthesizing protein for ${requestDisease}...`);
      socket.emit("request-matrix-job", {
        task: `Folding Simulation: ${requestDisease}`,
        matrixA,
        matrixB,
        dimension,
        roomId,
        type: "science",
      });
      setLastSubmittedMode("science");
      setResultPreview("");
      return;
    }

    setRequestStatus(`Uploading AI batch ${dimension}x${dimension} to room ${roomId}...`);
    socket.emit("request-matrix-job", {
      task: `AI Training Batch (${dimension}x${dimension})`,
      matrixA,
      matrixB,
      dimension,
      roomId,
      type: "matrix",
    });
    setLastSubmittedMode("ai");
    setResultPreview("");
  };

  const efficiencyPercent = useMemo(() => {
    const total = computeTime + transferTime;
    if (!total) return 0;
    return Math.round((computeTime / total) * 100);
  }, [computeTime, transferTime]);

  const idleWorkers = networkWorkers.filter((w) => w.status === "idle").length;

  const activePublicRooms = useMemo(() => {
    const roomCounts = new Map();
    networkWorkers.forEach((w) => {
      const room = w.roomId || "public";
      if (w.status === "idle" && room === "public") {
        roomCounts.set(room, (roomCounts.get(room) || 0) + 1);
      }
    });
    return Array.from(roomCounts.entries());
  }, [networkWorkers]);

  if (page === "donator") {
    return (
      <main className="page">
        {renderSiteTitle()}

        <section className="donator-layout">
          <aside className="panel metrics-panel">
            <h3>Live Performance Metrics</h3>
            <p className="socket-state">{workerConnected ? "Connected" : "Disconnected"} to {SOCKET_URL}</p>

            <div className="room-config">
              <label className="mini-label">Room Mode</label>
              <div className="radio-row">
                <label><input type="radio" name="roomType" checked={workerRoomType === "public"} onChange={() => setWorkerRoomType("public")} /> Public</label>
                <label><input type="radio" name="roomType" checked={workerRoomType === "private"} onChange={() => setWorkerRoomType("private")} /> Private</label>
              </div>
              {workerRoomType === "private" ? (
                <input value={workerRoomInput} onChange={(e) => setWorkerRoomInput(e.target.value)} placeholder="Enter room code" />
              ) : null}
              <button type="button" className="small-btn" onClick={() => setWorkerReconnectKey((v) => v + 1)}>Connect / Rejoin</button>
              <p className="worker-id">Current Room: {workerRoomId}</p>
            </div>

            <div className="gpu-ring" style={{ background: `conic-gradient(#00f6ff ${gpuUtilization * 3.6}deg, #1d2756 0deg)` }}>
              <div className="gpu-ring-inner"><span>{gpuUtilization}%</span></div>
            </div>
            <p className="metric-label">GPU Utilization Heatmap</p>

            <div className="metric-card">
              <p className="metric-label">Tasks Solved Counter</p>
              <p className="metric-value">{String(tasksSolved).padStart(6, "0")}</p>
            </div>

            <div className="metric-card">
              <p className="metric-label">Network Efficiency Monitor</p>
              <div className="efficiency-row">
                <span>Compute: {computeTime}ms</span>
                <span>Transfer: {transferTime}ms</span>
              </div>
              <div className="efficiency-bar"><span style={{ width: `${efficiencyPercent}%` }} /></div>
              <p className="metric-value small">{efficiencyPercent}% Efficient</p>
            </div>
          </aside>

          <section className="panel brain-panel">
            <h3>The Global Brain</h3>
            <p className="subtitle">A live neural sphere reacting to network compute activity.</p>
            <div className={`brain-sphere ${brainState}`}><span>Global Brain</span></div>
            <p className="state-text">State: <strong>{brainState === "computing" ? "Computing" : brainState === "disconnected" ? "Disconnected" : "Idle"}</strong></p>
            <p className="worker-id">Worker ID: {workerId ? `${workerId.slice(0, 8)}...` : "-"}</p>
          </section>

          <aside className="panel diagram-panel">
            <h3>Network Connection Diagram</h3>
            <div className="diagram-grid">
              <div className="node"><span className="pc-emoji">{"\u{1F4BB}"}</span><span>Receiver: Nova</span></div>
              <div className="node"><span className="pc-emoji">{"\u{1F4BB}"}</span><span>Receiver: Orion</span></div>
              <div className="node"><span className="pc-emoji">{"\u{1F4BB}"}</span><span>Receiver: Vega</span></div>
            </div>
            <div className="arrow-row">-&gt;  |  &lt;-</div>
            <div className="node donor-node"><span className="pc-emoji">{"\u{1F4BB}"}</span><span>Donator: You</span></div>
          </aside>
        </section>

        <section className="panel rewards-panel">
          <div>
            <h3>Live Leaderboard</h3>
            <ul className="leaderboard">
              <li>#1 CipherNode - 9241</li>
              <li>#2 QuantumMint - 8110</li>
              <li>#3 AtlasDonor - 7568</li>
              <li>#4 You - {tasksSolved}</li>
            </ul>
          </div>
          <div className="earnings-wrap">
            <p className="metric-label">Contribution &amp; Rewards</p>
            <p className="earnings-value">$BRAIN EARNED: {brainEarnings.toFixed(2)}</p>
            <p className="network-mini">Network: {idleWorkers} idle / {networkWorkers.length} total workers</p>
          </div>
          <div className="toggle-wrap">
            <p className="metric-label">Participation Toggle</p>
            <button type="button" className={`toggle-btn ${isParticipating ? "on" : "off"}`} onClick={() => setIsParticipating((prev) => !prev)}>
              {isParticipating ? "STOP" : "START"}
            </button>
          </div>
        </section>

        <button type="button" className="back-btn" onClick={() => setPage("role")}>Back to Roles</button>
      </main>
    );
  }

  if (page === "requestor") {
    return (
      <main className="page">
        {renderSiteTitle()}
        <section className="card requestor-card">
          <h2>Distributed Task Launcher</h2>
          <p className="subtitle">Select a computational task to offload to the grid.</p>

          <p className="socket-state">{requestConnected ? "Connected" : "Disconnected"} to {SOCKET_URL}</p>

          <div className="room-scanner">
            <p className="metric-label">Active Public Rooms</p>
            <div className="room-badges">
              {activePublicRooms.length === 0 ? <span className="network-status">No public workers.</span> : activePublicRooms.map(([name, count]) => (
                <button key={name} type="button" className="room-badge" onClick={() => setRequestRoom(name)}>{name}: {count}</button>
              ))}
            </div>
          </div>

          <div className="room-config">
            <label className="mini-label">Connect To</label>
            <div className="radio-row">
              <label>
                <input
                  type="radio"
                  name="requestTargetType"
                  checked={requestTargetType === "public"}
                  onChange={() => setRequestTargetType("public")}
                />
                Public Donor
              </label>
              <label>
                <input
                  type="radio"
                  name="requestTargetType"
                  checked={requestTargetType === "private"}
                  onChange={() => setRequestTargetType("private")}
                />
                Private Donor (Code)
              </label>
            </div>
            {requestTargetType === "private" ? (
              <input
                value={requestPrivateCode}
                onChange={(e) => setRequestPrivateCode(e.target.value)}
                placeholder="Enter secret room code"
              />
            ) : null}
          </div>

          <div className="mode-tabs">
            <button type="button" className={requestMode === "ai" ? "tab-btn active" : "tab-btn"} onClick={() => setRequestMode("ai")}>AI Training</button>
            <button type="button" className={requestMode === "science" ? "tab-btn active" : "tab-btn"} onClick={() => setRequestMode("science")}>Cure Finder</button>
          </div>

          {requestMode === "ai" ? (
            <>
              <label htmlFor="dimension">Matrix Dimension</label>
              <input id="dimension" type="number" min={16} value={requestDimension} onChange={(e) => setRequestDimension(e.target.value)} />
            </>
          ) : (
            <>
              <label htmlFor="disease">Disease Target</label>
              <select id="disease" value={requestDisease} onChange={(e) => setRequestDisease(e.target.value)}>
                <option value="Alzheimers">Alzheimer's (Amyloid-beta)</option>
                <option value="Cancer">p53 Tumor Suppressor</option>
                <option value="Covid">Spike Protein</option>
              </select>
            </>
          )}

          <label htmlFor="room">Target Public Room</label>
          <input
            id="room"
            value={requestRoom}
            onChange={(e) => setRequestRoom(e.target.value)}
            placeholder="public"
            disabled={requestTargetType === "private"}
          />

          <button type="button" onClick={launchRequestTask}>Launch Task</button>

          <div className="request-status-box">
            <p className="request-status">{requestStatus}</p>
            {resultPreview ? <p className="result-preview">Preview: {resultPreview}</p> : null}
          </div>
        </section>

        <button type="button" className="back-btn" onClick={() => setPage("role")}>Back to Roles</button>
      </main>
    );
  }

  if (page === "server") {
    const idle = networkWorkers.filter((w) => w.status === "idle").length;
    const busy = networkWorkers.filter((w) => w.status === "busy").length;

    return (
      <main className="page">
        {renderSiteTitle()}
        <section className="card server-card wide">
          <h2>Distributed Brain: Network Monitor</h2>
          <p className="socket-state">{adminConnected ? "Connected" : "Disconnected"} to {SOCKET_URL}</p>

          <div className="server-stats">
            <div className="metric-card"><p className="metric-label">Total Workers</p><p className="metric-value small">{networkWorkers.length}</p></div>
            <div className="metric-card"><p className="metric-label">Idle Workers</p><p className="metric-value small">{idle}</p></div>
            <div className="metric-card"><p className="metric-label">Busy Workers</p><p className="metric-value small">{busy}</p></div>
          </div>

          <div className="server-table-wrap">
            <table className="worker-table">
              <thead>
                <tr>
                  <th>Worker ID</th>
                  <th>Room</th>
                  <th>GPU</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {networkWorkers.map((w) => (
                  <tr key={w.id}>
                    <td>{String(w.id).slice(0, 8)}...</td>
                    <td><span className="room-pill">{w.roomId || "public"}</span></td>
                    <td>{w.gpuName || "Unknown"}</td>
                    <td className={w.status === "idle" ? "status-idle" : "status-busy"}>{String(w.status || "unknown").toUpperCase()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="server-log-box">
            <p className="metric-label">Activity Logs</p>
            {adminLogs.length === 0 ? (
              <p className="server-log-empty">System ready. Listening for events...</p>
            ) : (
              <ul className="server-log-list">
                {adminLogs.map((log, index) => (
                  <li key={`${log.time}-${index}`}>
                    <span className="server-log-time">[{log.time}]</span> {log.msg}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <button type="button" className="back-btn" onClick={() => setPage("role")}>Back to Roles</button>
      </main>
    );
  }

  if (page === "role") {
    return (
      <main className="page">
        {renderSiteTitle()}
        <section className="card options-card">
          <h2>Choose Your Role</h2>
          <p className="subtitle">Select how you want to use the network.</p>

          <div className="option-block">
            <button type="button" className="option-btn" onClick={() => setPage("donator")}>1: Donator (Worker)</button>
            <p className="option-title">Provide Power</p>
            <p className="option-description">Help the network by providing computation from your browser to solve tasks together.</p>
          </div>

          <div className="option-block">
            <button type="button" className="option-btn" onClick={() => setPage("requestor")}>2: User (Requestor)</button>
            <p className="option-title">Get Computation Power</p>
            <p className="option-description">Launch AI or science tasks and route them to specific public/private rooms.</p>
          </div>

          <div className="option-block">
            <button type="button" className="option-btn" onClick={() => setPage("server")}>3: Server (Admin)</button>
            <p className="option-title">Monitor Orchestrator</p>
            <p className="option-description">Track room-wise workers, statuses, and live activity logs.</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      {renderSiteTitle()}
      <section className="card">
        <h2>{mode === "register" ? "Create Account" : "Login"}</h2>
        <p className="subtitle">
          {mode === "register" ? "Share your compute power with the network." : "Access your account and continue sharing compute power."}
        </p>

        <form onSubmit={handleAuthSubmit} className="form" autoComplete="off">
          <label htmlFor="username">Username</label>
          <input id="username" name="username" type="text" value={formData.username} onChange={handleChange} required minLength={3} placeholder="Enter username" />

          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" value={formData.password} onChange={handleChange} required minLength={6} placeholder="Enter password" />

          <button type="submit">{mode === "register" ? "Register" : "Login"}</button>

          <p className="login-text">
            {mode === "register" ? "Already a user? " : "New user? "}
            <button type="button" className="switch-btn" onClick={() => setMode((prev) => (prev === "register" ? "login" : "register"))}>
              {mode === "register" ? "Login" : "Create Account"}
            </button>
          </p>
        </form>
      </section>
    </main>
  );
}

export default App;
