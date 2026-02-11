import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "http://192.168.1.62:3000";

const buildGlobeMesh = (nodeCount = 520, maxEdges = 2600) => {
  const nodes = [];
  const rand = (() => {
    let seed = 1337;
    return () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  })();

  for (let i = 0; i < nodeCount; i += 1) {
    const u = rand();
    const v = rand();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const x = Math.sin(phi) * Math.cos(theta);
    const y = Math.sin(phi) * Math.sin(theta);
    const z = Math.cos(phi);

    const px = 50 + x * 50;
    const py = 50 + y * 50;
    const depth = (z + 1) / 2;
    nodes.push({ x: px, y: py, z, depth });
  }

  const edgeCandidates = [];
  const maxDist = 8.4;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > maxDist) continue;

      const depth = (a.depth + b.depth) * 0.5;
      edgeCandidates.push({ i, j, dist, depth });
    }
  }

  edgeCandidates.sort((a, b) => a.dist - b.dist);
  const degree = new Array(nodes.length).fill(0);
  const edges = [];
  for (let k = 0; k < edgeCandidates.length; k += 1) {
    const edge = edgeCandidates[k];
    if (edges.length >= maxEdges) break;
    if (degree[edge.i] >= 9 || degree[edge.j] >= 9) continue;
    degree[edge.i] += 1;
    degree[edge.j] += 1;
    edges.push(edge);
  }

  return {
    nodes,
    edges,
  };
};

function App() {
  const [page, setPage] = useState("auth");
  const [mode, setMode] = useState("register");
  const [formData, setFormData] = useState({ username: "", password: "" });

  const workerSocketRef = useRef(null);
  const userSocketRef = useRef(null);
  const llmEngineRef = useRef(null);
  const llmLoadingRef = useRef(null);

  const [networkWorkers, setNetworkWorkers] = useState([]);

  const [workerConnected, setWorkerConnected] = useState(false);
  const [workerId, setWorkerId] = useState("");
  const [workerReceivers, setWorkerReceivers] = useState([]);
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
  const [llmModelId] = useState("Qwen2.5-0.5B-Instruct-q4f16_1-MLC");
  const [workerModelStatus, setWorkerModelStatus] = useState("Model not loaded");
  const [requestPrompt, setRequestPrompt] = useState("");
  const [requestMaxTokens, setRequestMaxTokens] = useState("128");
  const [requestTemperature, setRequestTemperature] = useState("0.7");
  const [requestTargetType, setRequestTargetType] = useState("public");
  const [requestRoom, setRequestRoom] = useState("public");
  const [requestPrivateCode, setRequestPrivateCode] = useState("");
  const [requestStatus, setRequestStatus] = useState("LLM request panel is ready.");
  const [resultPreview, setResultPreview] = useState("");

  const [adminConnected, setAdminConnected] = useState(false);
  const [adminLogs, setAdminLogs] = useState([]);
  const globeMesh = useMemo(() => buildGlobeMesh(), []);

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

    const dimension = Number.parseInt(payload.dimension, 10);
    if (!Number.isFinite(dimension) || dimension <= 0) {
      return { result: [], computeMs: 1, transferMs: 1, gpuLoad: 0 };
    }
    const safeDimension = Math.max(2, dimension);
    const rowCount = Math.max(1, Number(payload.rowCount) || safeDimension);
    const matrixA = Array.isArray(payload.matrixA) ? payload.matrixA : [];
    const matrixB = Array.isArray(payload.matrixB) ? payload.matrixB : [];
    if (!matrixA.length || !matrixB.length) {
      return { result: [], computeMs: 1, transferMs: 1, gpuLoad: 0 };
    }

    // Generate full chunk result size for server aggregation.
    const outputLength = rowCount * safeDimension;
    const inner = Math.min(safeDimension, 24);
    const result = new Array(outputLength);

    for (let idx = 0; idx < outputLength; idx += 1) {
      const row = Math.floor(idx / safeDimension) % rowCount;
      const col = idx % safeDimension;
      let sum = 0;
      for (let k = 0; k < inner; k += 1) {
        const a = Number(matrixA[row * safeDimension + k] || 0);
        const b = Number(matrixB[k * safeDimension + col] || 0);
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

  const ensureWorkerLLMEngine = async () => {
    if (llmEngineRef.current) return llmEngineRef.current;
    if (llmLoadingRef.current) return llmLoadingRef.current;

    llmLoadingRef.current = (async () => {
      setWorkerModelStatus(`Loading ${llmModelId}...`);
      const webllm = await import("@mlc-ai/web-llm");
      const engine = await webllm.CreateMLCEngine(llmModelId, {
        initProgressCallback: (report) => {
          const percent = Math.round((report.progress || 0) * 100);
          setWorkerModelStatus(`Loading ${llmModelId}: ${percent}%`);
        },
      });
      llmEngineRef.current = engine;
      setWorkerModelStatus(`Model ready: ${llmModelId}`);
      return engine;
    })().finally(() => {
      llmLoadingRef.current = null;
    });

    return llmLoadingRef.current;
  };

  const runWorkerLLMGenerate = async (payload) => {
    const prompt = String(payload.prompt || "").trim();
    const startedAt = performance.now();
    if (!prompt) {
      return {
        text: "No prompt was provided.",
        computeMs: 1,
      };
    }

    const engine = await ensureWorkerLLMEngine();
    const maxTokens = Math.max(8, Number.parseInt(payload.maxTokens, 10) || 128);
    const temperature = Number.isFinite(Number(payload.temperature))
      ? Number(payload.temperature)
      : 0.7;

    const response = await engine.chat.completions.create({
      model: llmModelId,
      messages: [
        {
          role: "system",
          content:
            "You are a coding assistant. Provide practical programming solutions. When code is requested, return clear runnable code in a fenced code block with language tag.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: maxTokens,
      temperature,
    });

    const text = response?.choices?.[0]?.message?.content || "";
    const endedAt = performance.now();
    return {
      text,
      computeMs: Math.max(1, Math.round(endedAt - startedAt)),
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
        llmCapable: true,
        gpuName: "WebGPU Adapter (Standard)",
        roomId: workerRoomId,
      });
      setBrainState("idle");
      // Warm up model right after donor connects to reduce first-request latency.
      ensureWorkerLLMEngine().catch((error) => {
        setWorkerModelStatus(`Model preload failed: ${error?.message || "Unknown error"}`);
      });
    });

    socket.on("disconnect", () => {
      setWorkerConnected(false);
      setBrainState("disconnected");
      setWorkerReceivers([]);
    });

    socket.on("network-status", (workers = []) => {
      setNetworkWorkers(workers);
    });

    socket.on("worker-links", (links = []) => {
      setWorkerReceivers(Array.isArray(links) ? links : []);
    });

    socket.on("compute-task", async (payload = {}) => {
      setBrainState("computing");

      const isLLMTask =
        payload.type === "llm_generate" ||
        payload.taskType === "llm_generate" ||
        typeof payload.prompt === "string";

      if (isLLMTask) {
        try {
          const { text, computeMs } = await runWorkerLLMGenerate(payload);
          setComputeTime(computeMs);
          setTransferTime(1);
          setGpuUtilization(95);
          setTasksSolved((prev) => prev + 1);
          setBrainEarnings((prev) => Number((prev + 0.95).toFixed(2)));
          socket.emit("compute-result", {
            result: { text, model: llmModelId },
            computeTimeMs: computeMs,
            from: payload.from,
            taskType: "llm_generate",
          });
        } catch (error) {
          socket.emit("compute-result", {
            result: {
              text: `LLM generation failed: ${error?.message || "Unknown error"}`,
              model: llmModelId,
            },
            computeTimeMs: 1,
            from: payload.from,
            taskType: "llm_generate",
          });
        } finally {
          setTimeout(() => setBrainState("idle"), 300);
        }
        return;
      }

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

    socket.on("job-finished", (result) => {
      if (result && typeof result === "object" && "text" in result) {
        setRequestStatus("LLM response received.");
        setResultPreview(String(result.text || ""));
        return;
      }

      if (typeof result === "string") {
        setRequestStatus("LLM response received.");
        setResultPreview(result);
        return;
      }

      const preview = Array.isArray(result)
        ? result.slice(0, 3).map((n) => Number(n).toFixed(2)).join(", ")
        : "";

      setRequestStatus(
        "Invalid worker response (numeric matrix output). Ensure Donator page is updated and LLM worker path is active.",
      );
      setResultPreview(preview ? `[${preview}...]` : "");
    });

    return () => {
      socket.disconnect();
      userSocketRef.current = null;
    };
  }, [page]);

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
    const prompt = requestPrompt.trim();
    if (!prompt) {
      setRequestStatus("Enter a prompt first.");
      return;
    }

    const maxTokens = Math.max(8, Number.parseInt(requestMaxTokens, 10) || 128);
    const temperature = Number(requestTemperature);

    setRequestStatus(`Dispatching LLM prompt to room ${roomId}...`);
    setResultPreview("");
    socket.emit("request-matrix-job", {
      task: "LLM Generation",
      type: "llm_generate",
      prompt,
      maxTokens,
      temperature: Number.isFinite(temperature) ? temperature : 0.7,
      roomId,
      modelId: llmModelId,
    });
  };

  const efficiencyPercent = useMemo(() => {
    const total = computeTime + transferTime;
    if (!total) return 0;
    return Math.round((computeTime / total) * 100);
  }, [computeTime, transferTime]);

  const idleWorkers = networkWorkers.filter((w) => w.status === "idle").length;
  const visibleWorkerReceivers = workerReceivers.slice(0, 3);

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
            <p className="socket-state">{workerModelStatus}</p>

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
            <div className={`brain-sphere ${brainState}`}>
              <svg className="brain-mesh-svg" viewBox="0 0 100 100" role="img" aria-hidden="true">
                {globeMesh.edges.map((edge, idx) => {
                  const a = globeMesh.nodes[edge.i];
                  const b = globeMesh.nodes[edge.j];
                  const edgeOpacity = Math.min(0.92, 0.2 + edge.depth * 0.66);
                  return (
                    <line
                      key={`e-${idx}`}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke={`rgba(120, 246, 255, ${edgeOpacity.toFixed(3)})`}
                      strokeWidth={edge.depth > 0.7 ? 0.34 : 0.24}
                    />
                  );
                })}
                {globeMesh.nodes.map((n, idx) => {
                  const r = 0.18 + n.depth * 0.24;
                  const nodeOpacity = 0.36 + n.depth * 0.6;
                  return (
                    <circle
                      key={`n-${idx}`}
                      cx={n.x}
                      cy={n.y}
                      r={r}
                      fill={`rgba(174, 252, 255, ${nodeOpacity.toFixed(3)})`}
                    />
                  );
                })}
              </svg>
              <span>Global Brain</span>
            </div>
            <p className="state-text">State: <strong>{brainState === "computing" ? "Computing" : brainState === "disconnected" ? "Disconnected" : "Idle"}</strong></p>
            <p className="worker-id">Worker ID: {workerId ? `${workerId.slice(0, 8)}...` : "-"}</p>
          </section>

          <aside className="panel diagram-panel">
            <h3>Network Connection Diagram</h3>
            <div
              className="diagram-grid"
              style={
                visibleWorkerReceivers.length > 0
                  ? { gridTemplateColumns: `repeat(${visibleWorkerReceivers.length}, minmax(0, 1fr))` }
                  : undefined
              }
            >
              {visibleWorkerReceivers.length === 0 ? (
                <div className="node empty-node"><span>No active receivers yet</span></div>
              ) : (
                visibleWorkerReceivers.map((link) => (
                  <div className="node" key={link.receiverId}>
                    <span className="pc-emoji">{"\u{1F4BB}"}</span>
                    <span>Receiver: {String(link.receiverId || "").slice(0, 6)}...</span>
                  </div>
                ))
              )}
            </div>
            {visibleWorkerReceivers.length > 0 ? (
              <div
                className="connection-lanes"
                style={{ gridTemplateColumns: `repeat(${visibleWorkerReceivers.length}, minmax(0, 1fr))` }}
              >
                {visibleWorkerReceivers.map((link) => (
                  <div className="connection-lane" key={`lane-${link.receiverId}`}>
                    <span className="lane-line" />
                    <span className="lane-arrow" />
                  </div>
                ))}
              </div>
            ) : null}
            <div className="node donor-node">
              <span className="pc-emoji">{"\u{1F4BB}"}</span>
              <span>Donator: You</span>
            </div>
            {workerReceivers.length > 3 ? (
              <p className="diagram-note">+{workerReceivers.length - 3} more active receiver(s)</p>
            ) : null}
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
          <h2>LLM Requestor</h2>
          <p className="subtitle">Submit prompts to distributed donor workers running Qwen 0.5B class models.</p>

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

          <label htmlFor="prompt">Prompt</label>
          <textarea
            id="prompt"
            value={requestPrompt}
            onChange={(e) => setRequestPrompt(e.target.value)}
            rows={7}
            placeholder="Ask your question here..."
          />

          <div className="llm-config-grid">
            <div>
              <label htmlFor="maxTokens">Max Tokens</label>
              <input
                id="maxTokens"
                type="number"
                min={8}
                max={512}
                value={requestMaxTokens}
                onChange={(e) => setRequestMaxTokens(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="temperature">Temperature</label>
              <input
                id="temperature"
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={requestTemperature}
                onChange={(e) => setRequestTemperature(e.target.value)}
              />
            </div>
          </div>

          <label htmlFor="room">Target Public Room</label>
          <input
            id="room"
            value={requestRoom}
            onChange={(e) => setRequestRoom(e.target.value)}
            placeholder="public"
            disabled={requestTargetType === "private"}
          />

          <button type="button" onClick={launchRequestTask}>Generate Response</button>

          <div className="request-status-box">
            <p className="request-status">{requestStatus}</p>
          </div>

          <div className="llm-response-box">
            <p className="metric-label">LLM Response</p>
            {resultPreview ? (
              <p className="result-preview">{resultPreview}</p>
            ) : (
              <p className="result-empty">Response will appear here after generation.</p>
            )}
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
