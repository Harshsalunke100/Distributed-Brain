import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "http://localhost:3000";
const SOCKET_OPTIONS = {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 8000,
  timeout: 10000,
  transports: ["websocket", "polling"],
};
const SESSION_TOKEN_KEY = "distributed_brain_session_token";
const METRIC_WINDOW_SIZE = 12;

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
  const [authToken, setAuthToken] = useState("");
  const [authUser, setAuthUser] = useState(null);
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  const workerSocketRef = useRef(null);
  const activeWorkerTaskRef = useRef(null);
  const userSocketRef = useRef(null);
  const llmEngineRef = useRef(null);
  const llmLoadingRef = useRef(null);
  const gpuInfoLoadingRef = useRef(null);
  const requestTimeoutRef = useRef(null);
  const authTokenRef = useRef("");
  const metricSamplesRef = useRef([]);

  const [networkWorkers, setNetworkWorkers] = useState([]);
  const [networkClients, setNetworkClients] = useState({
    donors: 0,
    idleDonors: 0,
    busyDonors: 0,
    requestors: 0,
    admins: 0,
    requestorsList: [],
  });

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
  const [requestPreferredDonorId, setRequestPreferredDonorId] = useState("");
  const [requestStatus, setRequestStatus] = useState("LLM request panel is ready.");
  const [resultPreview, setResultPreview] = useState("");
  const [requestLoading, setRequestLoading] = useState(false);
  const [requestAssignedDonor, setRequestAssignedDonor] = useState("");

  const [adminConnected, setAdminConnected] = useState(false);
  const [adminLogs, setAdminLogs] = useState([]);
  const [leaderboardRows, setLeaderboardRows] = useState([]);
  const [leaderboardStatus, setLeaderboardStatus] = useState("Loading leaderboard...");
  const globeMesh = useMemo(() => buildGlobeMesh(), []);

  const workerRoomId = useMemo(() => {
    if (workerRoomType === "private") {
      return workerRoomInput.trim() || "public";
    }
    return "public";
  }, [workerRoomInput, workerRoomType]);

  const apiBaseUrl = useMemo(() => SOCKET_URL.replace(/\/$/, ""), []);

  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  const setAuthSession = (token, user) => {
    setAuthToken(token);
    setAuthUser(user);
    setBrainEarnings(Number(user?.brainEarnings || 0));
    if (token) {
      localStorage.setItem(SESSION_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(SESSION_TOKEN_KEY);
    }
  };

  const clearAuthSession = () => {
    setAuthSession("", null);
    setPage("auth");
    setBrainEarnings(0);
    setTasksSolved(0);
  };

  const fetchApi = async (path, { method = "GET", body, token, timeoutMs = 10000 } = {}) => {
    const headers = {};
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const authHeaderToken = token ?? authTokenRef.current;
    if (authHeaderToken) {
      headers.Authorization = `Bearer ${authHeaderToken}`;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(`${apiBaseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`Server timeout after ${Math.round(timeoutMs / 1000)}s. Check backend at ${apiBaseUrl}.`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || `Request failed (${response.status})`);
    }
    return payload;
  };

  useEffect(() => {
    const run = async () => {
      const token = localStorage.getItem(SESSION_TOKEN_KEY);
      if (!token) return;
      try {
        const payload = await fetchApi("/api/session", { token });
        setAuthSession(token, payload.user);
        setPage("role");
      } catch {
        localStorage.removeItem(SESSION_TOKEN_KEY);
      }
    };
    run();
  }, []);

  useEffect(() => {
    if (page !== "auth" && !authUser) {
      setPage("auth");
    }
  }, [authUser, page]);

  useEffect(() => {
    if (page !== "donator") return undefined;

    loadLeaderboard();
    const intervalId = setInterval(() => {
      loadLeaderboard();
    }, 15000);

    return () => clearInterval(intervalId);
  }, [page]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setAuthError("");
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    const username = formData.username.trim();
    const password = formData.password;

    if (!username || !password) {
      setAuthError("Username and password are required.");
      return;
    }

    setAuthBusy(true);
    setAuthError("");
    try {
      const path = mode === "register" ? "/api/register" : "/api/login";
      const payload = await fetchApi(path, {
        method: "POST",
        body: { username, password },
      });
      setAuthSession(payload.token, payload.user);
      setPage("role");
    } catch (error) {
      const raw = String(error?.message || "");
      setAuthError(raw || "Authentication failed.");
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = async () => {
    const token = authTokenRef.current;
    try {
      if (token) {
        await fetchApi("/api/logout", { method: "POST", token });
      }
    } catch {
      // Ignore logout transport errors and clear local session anyway.
    } finally {
      clearAuthSession();
    }
  };

  const loadLeaderboard = async () => {
    try {
      const payload = await fetchApi("/api/leaderboard?limit=8", { timeoutMs: 7000 });
      const rows = Array.isArray(payload?.leaderboard) ? payload.leaderboard : [];
      setLeaderboardRows(rows);
      setLeaderboardStatus(rows.length ? "" : "No donor earnings yet.");
    } catch (error) {
      const message = String(error?.message || "Unable to load leaderboard.");
      if (message.toLowerCase().includes("api route not found")) {
        setLeaderboardStatus("Backend is outdated. Restart server with latest code.");
        return;
      }
      setLeaderboardStatus(message);
    }
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
    const workload = outputLength * inner;
    const normalizedLoad = Math.min(1, workload / 75000);
    const gpuLoad = Math.round(38 + normalizedLoad * 52);
    return {
      result,
      computeMs: Math.max(1, Math.round(endedAt - startedAt)),
      transferMs: Math.max(1, Math.round((matrixA.length + matrixB.length) / 2000)),
      gpuLoad: Math.min(98, Math.max(12, gpuLoad)),
    };
  };

  const boostGpuUtilization = (value) => {
    const safeValue = Math.min(98, Math.max(0, Number(value) || 0));
    setGpuUtilization((prev) => Math.max(prev, safeValue));
  };

  const detectWorkerGpuInfo = async () => {
    if (gpuInfoLoadingRef.current) return gpuInfoLoadingRef.current;

    gpuInfoLoadingRef.current = (async () => {
      if (typeof navigator === "undefined" || !navigator.gpu) {
        return { hasWebGPU: false, gpuName: "WebGPU Unavailable" };
      }

      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
          return { hasWebGPU: false, gpuName: "No WebGPU Adapter" };
        }

        const info = adapter.info || {};
        const parts = [
          String(info.vendor || "").trim(),
          String(info.architecture || "").trim(),
          String(info.device || "").trim(),
          String(info.description || "").trim(),
        ].filter(Boolean);
        const gpuName = parts.length ? parts.join(" | ") : "WebGPU Adapter (Detected)";
        return { hasWebGPU: true, gpuName };
      } catch {
        return { hasWebGPU: Boolean(navigator.gpu), gpuName: "WebGPU Adapter (Access Limited)" };
      }
    })().finally(() => {
      gpuInfoLoadingRef.current = null;
    });

    return gpuInfoLoadingRef.current;
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
          boostGpuUtilization(20 + Math.round((report.progress || 0) * 60));
        },
      });
      llmEngineRef.current = engine;
      setWorkerModelStatus(`Model ready: ${llmModelId}`);
      setGpuUtilization((prev) => Math.max(10, Math.min(prev, 22)));
      return engine;
    })().finally(() => {
      llmLoadingRef.current = null;
    });

    return llmLoadingRef.current;
  };

  const resetWorkerLLMEngine = async () => {
    const engine = llmEngineRef.current;
    llmEngineRef.current = null;
    llmLoadingRef.current = null;
    if (!engine) return;
    try {
      if (typeof engine.interruptGenerate === "function") {
        await engine.interruptGenerate();
      }
    } catch {
      // ignore interruption errors
    }
    try {
      if (typeof engine.unload === "function") {
        await engine.unload();
      }
    } catch {
      // ignore unload errors
    }
    setWorkerModelStatus("Model reset after cancellation. Reloading on next request...");
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
    if (typeof engine.resetChat === "function") {
      try {
        await engine.resetChat();
      } catch {
        // ignore chat reset failures
      }
    }
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

    const finishReason = response?.choices?.[0]?.finish_reason;
    const rawText = response?.choices?.[0]?.message?.content;
    const text = typeof rawText === "string" ? rawText : "";
    const endedAt = performance.now();
    const promptBytes = String(prompt).length;
    const responseBytes = String(text).length;
    const transferMs = Math.max(2, Math.round((promptBytes + responseBytes) / 140));
    const gpuLoad = Math.min(98, Math.max(45, Math.round(40 + Math.min(55, (endedAt - startedAt) / 380))));
    return {
      text: text || (finishReason === "abort" ? "Generation interrupted on donor." : "No text generated."),
      computeMs: Math.max(1, Math.round(endedAt - startedAt)),
      transferMs,
      gpuLoad,
    };
  };

  const recordTaskMetrics = ({ computeMs, transferMs, gpuLoad }) => {
    const safeCompute = Math.max(1, Number(computeMs) || 1);
    const safeTransfer = Math.max(1, Number(transferMs) || 1);
    const safeGpu = Math.min(98, Math.max(0, Number(gpuLoad) || 0));

    const nextSamples = [...metricSamplesRef.current, {
      computeMs: safeCompute,
      transferMs: safeTransfer,
      gpuLoad: safeGpu,
    }].slice(-METRIC_WINDOW_SIZE);
    metricSamplesRef.current = nextSamples;

    const totals = nextSamples.reduce((acc, sample) => ({
      computeMs: acc.computeMs + sample.computeMs,
      transferMs: acc.transferMs + sample.transferMs,
      gpuLoad: acc.gpuLoad + sample.gpuLoad,
    }), { computeMs: 0, transferMs: 0, gpuLoad: 0 });

    const count = nextSamples.length || 1;
    setComputeTime(Math.round(totals.computeMs / count));
    setTransferTime(Math.round(totals.transferMs / count));
    setGpuUtilization(Math.round(totals.gpuLoad / count));
    setTasksSolved((prev) => prev + 1);
  };

  const creditBrainEarnings = async (delta) => {
    if (!Number.isFinite(delta) || delta <= 0) return;

    setBrainEarnings((prev) => Number((prev + delta).toFixed(2)));
    setAuthUser((prev) => (
      prev
        ? { ...prev, brainEarnings: Number((Number(prev.brainEarnings || 0) + delta).toFixed(2)) }
        : prev
    ));

    if (!authTokenRef.current) return;

    try {
      const payload = await fetchApi("/api/donor/earnings", {
        method: "POST",
        body: { delta },
      });
      if (payload?.user) {
        setAuthUser(payload.user);
        setBrainEarnings(Number(payload.user.brainEarnings || 0));
        loadLeaderboard();
      }
    } catch (error) {
      if (String(error?.message || "").toLowerCase().includes("session")) {
        clearAuthSession();
      }
    }
  };

  useEffect(() => {
    if (page !== "donator" || !isParticipating) {
      setBrainState(isParticipating ? "idle" : "disconnected");
      return undefined;
    }

    const socket = io(SOCKET_URL, SOCKET_OPTIONS);
    workerSocketRef.current = socket;

    socket.on("connect", () => {
      setWorkerConnected(true);
      setWorkerId(socket.id);
      socket.emit("register-worker", {
        hasWebGPU: typeof navigator !== "undefined" && Boolean(navigator.gpu),
        llmCapable: false,
        gpuName: "Detecting adapter...",
        roomId: workerRoomId,
        username: authUser?.username || "",
      });
      setBrainState("idle");
      detectWorkerGpuInfo().then((gpuInfo) => {
        if (socket.connected) {
          socket.emit("update-worker-capability", gpuInfo);
        }
      });
      // Warm up model right after donor connects to reduce first-request latency.
      ensureWorkerLLMEngine()
        .then(() => {
          if (socket.connected) {
            socket.emit("update-worker-capability", { llmCapable: true });
          }
        })
        .catch((error) => {
          if (socket.connected) {
            socket.emit("update-worker-capability", { llmCapable: false });
          }
          setWorkerModelStatus(`Model preload failed: ${error?.message || "Unknown error"}`);
        });
    });

    socket.on("disconnect", () => {
      setWorkerConnected(false);
      setBrainState("disconnected");
      setWorkerReceivers([]);
    });
    socket.on("connect_error", (error) => {
      setWorkerConnected(false);
      setBrainState("disconnected");
      setWorkerModelStatus(`Connection error: ${error?.message || "Socket connection failed"}`);
    });

    socket.on("network-status", (workers = []) => {
      setNetworkWorkers(workers);
    });
    socket.on("network-clients", (stats = {}) => {
      setNetworkClients((prev) => ({ ...prev, ...stats }));
    });

    socket.on("worker-links", (links = []) => {
      setWorkerReceivers(Array.isArray(links) ? links : []);
    });

    socket.on("cancel-compute-task", async ({ jobId, chunkId } = {}) => {
      const currentTask = activeWorkerTaskRef.current;
      if (!currentTask) return;
      if (currentTask.jobId !== jobId) return;
      if (Number(currentTask.chunkId ?? 0) !== Number(chunkId ?? 0)) return;

      currentTask.cancelRequested = true;
      if (currentTask.isLLMTask && llmEngineRef.current) {
        try {
          await llmEngineRef.current.interruptGenerate();
        } catch {
          // ignore interruption errors
        }
        await resetWorkerLLMEngine();
      }
    });

    socket.on("compute-task", async (payload = {}) => {
      setBrainState("computing");

      const isLLMTask =
        payload.type === "llm_generate" ||
        payload.taskType === "llm_generate" ||
        typeof payload.prompt === "string";
      const taskControl = {
        jobId: payload.jobId,
        chunkId: payload.chunkId ?? 0,
        isLLMTask,
        cancelRequested: false,
      };
      activeWorkerTaskRef.current = taskControl;

      if (isLLMTask) {
        try {
          const { text, computeMs, transferMs, gpuLoad } = await runWorkerLLMGenerate(payload);
          if (taskControl.cancelRequested) {
            return;
          }
          recordTaskMetrics({ computeMs, transferMs, gpuLoad });
          creditBrainEarnings(0.95);
          socket.emit("compute-result", {
            jobId: payload.jobId,
            chunkId: payload.chunkId ?? 0,
            result: { text, model: llmModelId },
            computeTimeMs: computeMs,
            from: payload.from,
            taskType: "llm_generate",
          });
        } catch (error) {
          if (taskControl.cancelRequested) {
            return;
          }
          socket.emit("compute-result", {
            jobId: payload.jobId,
            chunkId: payload.chunkId ?? 0,
            result: {
              text: `LLM generation failed: ${error?.message || "Unknown error"}`,
              model: llmModelId,
            },
            computeTimeMs: 1,
            from: payload.from,
            taskType: "llm_generate",
          });
        } finally {
          if (activeWorkerTaskRef.current === taskControl) {
            activeWorkerTaskRef.current = null;
          }
          setTimeout(() => setBrainState("idle"), 300);
        }
        return;
      }

      const { result, computeMs, transferMs, gpuLoad } = runWorkerCompute(payload);
      if (taskControl.cancelRequested) {
        if (activeWorkerTaskRef.current === taskControl) {
          activeWorkerTaskRef.current = null;
        }
        setTimeout(() => setBrainState("idle"), 300);
        return;
      }
      recordTaskMetrics({ computeMs, transferMs, gpuLoad });
      creditBrainEarnings(0.42);

      socket.emit("compute-result", {
        jobId: payload.jobId,
        chunkId: payload.chunkId,
        result,
        computeTimeMs: computeMs,
        from: payload.from,
      });
      if (activeWorkerTaskRef.current === taskControl) {
        activeWorkerTaskRef.current = null;
      }
      setTimeout(() => setBrainState("idle"), 300);
    });

    return () => {
      activeWorkerTaskRef.current = null;
      socket.disconnect();
      workerSocketRef.current = null;
    };
  }, [authUser?.username, isParticipating, page, workerReconnectKey, workerRoomId]);

  useEffect(() => {
    if (page !== "donator") {
      setGpuUtilization(0);
      return undefined;
    }

    const intervalId = setInterval(() => {
      setGpuUtilization((prev) => {
        if (!workerConnected || !isParticipating || brainState === "disconnected") {
          return Math.max(0, prev - 10);
        }
        if (brainState === "computing") {
          return Math.max(42, prev);
        }
        if (prev > 20) {
          return prev - 4;
        }
        return 9 + Math.floor(Math.random() * 7);
      });
    }, 1100);

    return () => clearInterval(intervalId);
  }, [brainState, isParticipating, page, workerConnected]);

  useEffect(() => {
    if (page !== "requestor") return undefined;

    const socket = io(SOCKET_URL, SOCKET_OPTIONS);
    userSocketRef.current = socket;

    socket.on("connect", () => {
      setRequestConnected(true);
      socket.emit("register-requestor", { username: authUser?.username || "" });
    });
    socket.on("disconnect", () => setRequestConnected(false));
    socket.on("connect_error", (error) => {
      setRequestConnected(false);
      setRequestLoading(false);
      setRequestStatus(`Connection error: ${error?.message || "Unable to reach server"}`);
    });
    socket.on("network-status", (workers = []) => setNetworkWorkers(workers));
    socket.on("network-clients", (stats = {}) => {
      setNetworkClients((prev) => ({ ...prev, ...stats }));
    });

    socket.on("job-status", (msg = {}) => {
      if (msg.status === "Failed") {
        if (requestTimeoutRef.current) {
          clearTimeout(requestTimeoutRef.current);
          requestTimeoutRef.current = null;
        }
        setRequestLoading(false);
        setRequestAssignedDonor("");
        setRequestStatus(msg.msg || "Job failed.");
        return;
      }
      if (msg.status === "Cancelled") {
        if (requestTimeoutRef.current) {
          clearTimeout(requestTimeoutRef.current);
          requestTimeoutRef.current = null;
        }
        setRequestLoading(false);
        setRequestAssignedDonor("");
        setRequestStatus(msg.msg || "Generation stopped.");
        return;
      }
      if (msg.status === "Retrying") {
        setRequestStatus(msg.msg || "Worker changed. Auto-retrying with active donors...");
        return;
      }
      if (msg.status === "Assigned") {
        if (msg.workerUsername) {
          setRequestAssignedDonor(String(msg.workerUsername));
        }
        setRequestStatus(msg.msg || `Assigned to Worker: ${String(msg.worker || "").slice(0, 6)}...`);
      } else {
        setRequestStatus(msg.msg || "Queued. Waiting for worker...");
      }
    });

    socket.on("job-finished", (result) => {
      if (requestTimeoutRef.current) {
        clearTimeout(requestTimeoutRef.current);
        requestTimeoutRef.current = null;
      }
      setRequestLoading(false);
      setRequestAssignedDonor("");

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
      if (requestTimeoutRef.current) {
        clearTimeout(requestTimeoutRef.current);
        requestTimeoutRef.current = null;
      }
      setRequestLoading(false);
      setRequestAssignedDonor("");
      socket.disconnect();
      userSocketRef.current = null;
    };
  }, [authUser?.username, page]);

  useEffect(() => {
    if (page !== "server") return undefined;

    const socket = io(SOCKET_URL, SOCKET_OPTIONS);

    socket.on("connect", () => {
      setAdminConnected(true);
      socket.emit("register-admin");
    });

    socket.on("disconnect", () => setAdminConnected(false));
    socket.on("connect_error", () => setAdminConnected(false));
    socket.on("network-status", (workers = []) => setNetworkWorkers(workers));
    socket.on("network-clients", (stats = {}) => {
      setNetworkClients((prev) => ({ ...prev, ...stats }));
    });
    socket.on("admin-activity", (item) => {
      if (!item) return;
      setAdminLogs((prev) => [item, ...prev].slice(0, 50));
    });

    return () => socket.disconnect();
  }, [page]);

  const launchRequestTask = () => {
    const socket = userSocketRef.current;
    if (!socket || !socket.connected) {
      setRequestLoading(false);
      setRequestStatus("Not connected to server.");
      return;
    }

    const roomId =
      requestTargetType === "private"
        ? requestPrivateCode.trim()
        : requestRoom.trim() || "public";

    if (!roomId) {
      setRequestLoading(false);
      setRequestStatus("Enter private room code to connect to a private donor.");
      return;
    }
    const prompt = requestPrompt.trim();
    if (!prompt) {
      setRequestLoading(false);
      setRequestStatus("Enter a prompt first.");
      return;
    }

    const maxTokens = Math.max(8, Number.parseInt(requestMaxTokens, 10) || 128);
    const temperature = Number(requestTemperature);

    setRequestLoading(true);
    setRequestAssignedDonor("");
    setRequestStatus(`Dispatching LLM prompt to room ${roomId}...`);
    setResultPreview("");
    if (requestTimeoutRef.current) {
      clearTimeout(requestTimeoutRef.current);
    }
    requestTimeoutRef.current = setTimeout(() => {
      setRequestStatus("Request is taking longer than expected. Auto-retrying with active donors...");
    }, 240000);

    socket.emit("request-matrix-job", {
      task: "LLM Generation",
      type: "llm_generate",
      prompt,
      maxTokens,
      temperature: Number.isFinite(temperature) ? temperature : 0.7,
      roomId,
      modelId: llmModelId,
      preferredWorkerId: requestTargetType === "public" ? requestPreferredDonorId : "",
    });
  };

  const stopRequestTask = () => {
    const socket = userSocketRef.current;
    if (!socket || !socket.connected) {
      setRequestLoading(false);
      setRequestStatus("Not connected to server.");
      return;
    }

    if (requestTimeoutRef.current) {
      clearTimeout(requestTimeoutRef.current);
      requestTimeoutRef.current = null;
    }
    setRequestLoading(false);
    setRequestAssignedDonor("");
    setRequestStatus("Stopping generation...");
    socket.emit("cancel-request-jobs");
  };

  const efficiencyPercent = useMemo(() => {
    const total = computeTime + transferTime;
    if (!total) return 0;
    return Math.round((computeTime / total) * 100);
  }, [computeTime, transferTime]);

  const idleWorkers = networkWorkers.filter((w) => w.status === "idle").length;
  const idleDonorWorkers = networkWorkers.filter((w) => w.status === "idle");
  const connectedDonorWorkers = networkWorkers;
  const connectedRequestors = Array.isArray(networkClients.requestorsList) ? networkClients.requestorsList : [];

  const activePublicRooms = useMemo(() => {
    const roomCounts = new Map();
    networkWorkers.forEach((w) => {
      const room = w.roomId || "public";
      if (w.status === "idle" && room === "public" && w.llmCapable) {
        roomCounts.set(room, (roomCounts.get(room) || 0) + 1);
      }
    });
    return Array.from(roomCounts.entries());
  }, [networkWorkers]);

  const idlePublicDonors = useMemo(() => (
    networkWorkers.filter((w) => (
      w.status === "idle" &&
      (w.roomId || "public") === "public" &&
      w.llmCapable
    ))
  ), [networkWorkers]);

  useEffect(() => {
    if (!requestPreferredDonorId) return;
    const stillAvailable = idlePublicDonors.some((w) => w.id === requestPreferredDonorId);
    if (!stillAvailable) {
      setRequestPreferredDonorId("");
    }
  }, [idlePublicDonors, requestPreferredDonorId]);

  useEffect(() => {
    if (requestTargetType === "private") {
      setRequestPreferredDonorId("");
    }
  }, [requestTargetType]);

  const getSafeRoomLabel = (roomId) => (String(roomId || "public") === "public" ? "public" : "private");
  const currentWorkerGpuName = useMemo(() => {
    const worker = networkWorkers.find((w) => w.id === workerId);
    return worker?.gpuName || "Detecting adapter...";
  }, [networkWorkers, workerId]);

  if (page === "donator") {
    return (
      <main className="page">
        {renderSiteTitle()}

        <section className="donator-layout">
          <aside className="panel metrics-panel">
            <h3>Live Performance Metrics</h3>
            <p className="socket-state">{workerConnected ? "Connected" : "Disconnected"} to {SOCKET_URL}</p>
            <p className="socket-state">{workerModelStatus}</p>
            <p className="socket-state">Detected GPU: {currentWorkerGpuName}</p>

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
              <p className="worker-id">Current Room: {getSafeRoomLabel(workerRoomId)}</p>
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
            <p className="worker-id">Donor Username: {authUser?.username || (workerId ? `${workerId.slice(0, 8)}...` : "-")}</p>
          </section>

          <aside className="panel diagram-panel">
            <h3>Network Connection Diagram</h3>
            <p className="socket-state">Donors: {networkClients.donors} | Idle: {networkClients.idleDonors} | Busy: {networkClients.busyDonors}</p>
            <p className="socket-state">Users: {networkClients.requestors} | Admins: {networkClients.admins}</p>

            <div className="diagram-group">
              <p className="metric-label">Idle Donors</p>
              <div className="diagram-grid">
                {idleDonorWorkers.length === 0 ? (
                  <div className="node empty-node"><span>No idle donors</span></div>
                ) : (
                  idleDonorWorkers.map((worker) => (
                    <div className="node" key={`idle-${worker.id}`}>
                      <span className="pc-emoji">{"\u{1F4BB}"}</span>
                      <span>{worker.username || `${String(worker.id || "").slice(0, 6)}...`} [{getSafeRoomLabel(worker.roomId)}]</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="diagram-group">
              <p className="metric-label">Connected Donors</p>
              <div className="diagram-grid">
                {connectedDonorWorkers.length === 0 ? (
                  <div className="node empty-node"><span>No donors connected</span></div>
                ) : (
                  connectedDonorWorkers.map((worker) => (
                    <div className="node" key={`donor-${worker.id}`}>
                      <span className="pc-emoji">{"\u{1F4BB}"}</span>
                      <span>{worker.username || `${String(worker.id || "").slice(0, 6)}...`} [{worker.status}]</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="diagram-group">
              <p className="metric-label">Connected Users</p>
              <div className="diagram-grid">
                {connectedRequestors.length === 0 ? (
                  <div className="node empty-node"><span>No users connected</span></div>
                ) : (
                  connectedRequestors.map((requestor) => (
                    <div className="node" key={`requestor-${requestor.id}`}>
                      <span className="pc-emoji">{"\u{1F464}"}</span>
                      <span>User: {requestor.username || `${String(requestor.id || "").slice(0, 6)}...`}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </aside>
        </section>

        <section className="panel rewards-panel">
          <div>
            <h3>Live Leaderboard</h3>
            <ul className="leaderboard">
              {leaderboardRows.length > 0 ? leaderboardRows.map((row) => {
                const isCurrentUser = String(row.username || "").toLowerCase() === String(authUser?.username || "").toLowerCase();
                return (
                  <li key={row.id || `${row.username}-${row.rank}`}>
                    #{row.rank} {row.username}{isCurrentUser ? " (You)" : ""} - {Number(row.brainEarnings || 0).toFixed(2)}
                  </li>
                );
              }) : (
                <li>{leaderboardStatus}</li>
              )}
            </ul>
          </div>
          <div className="session-wrap metric-card">
            <p className="metric-label">Account Session</p>
            <p className="socket-state">Signed in as {authUser?.username || "Unknown"}</p>
            <p className="socket-state">Lifetime $BRAIN: {Number(authUser?.brainEarnings || 0).toFixed(2)}</p>
            <button type="button" className="small-btn" onClick={handleLogout}>Logout</button>
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

          <div className="room-scanner">
            <p className="metric-label">Idle Donor Usernames</p>
            {requestTargetType === "private" ? (
              <span className="network-status">Idle donor list is available in public mode.</span>
            ) : (
              <>
                <div className="donor-picker-row">
                  <label htmlFor="preferredDonor">Choose Donor</label>
                  <select
                    className="compact-select"
                    id="preferredDonor"
                    value={requestPreferredDonorId}
                    onChange={(e) => setRequestPreferredDonorId(e.target.value)}
                  >
                    <option value="">Auto-assign any idle donor</option>
                    {idlePublicDonors.map((donor) => (
                      <option key={donor.id} value={donor.id}>
                        {donor.username || `${String(donor.id || "").slice(0, 6)}...`}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="room-badges">
                  {idlePublicDonors.length === 0 ? (
                    <span className="network-status">No idle public donors right now.</span>
                  ) : idlePublicDonors.map((donor) => (
                    <span key={`idle-public-donor-${donor.id}`} className="room-badge">
                      {donor.username || `${String(donor.id || "").slice(0, 6)}...`}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>

          <label htmlFor="prompt">Prompt</label>
          <textarea
            className="request-prompt"
            id="prompt"
            value={requestPrompt}
            onChange={(e) => setRequestPrompt(e.target.value)}
            rows={5}
            placeholder="Ask your question here..."
          />

          <div className="llm-config-grid">
            <div className="llm-config-item">
              <label htmlFor="maxTokens">Max Tokens</label>
              <input
                className="compact-input"
                id="maxTokens"
                type="number"
                min={8}
                max={512}
                value={requestMaxTokens}
                onChange={(e) => setRequestMaxTokens(e.target.value)}
              />
            </div>
            <div className="llm-config-item">
              <label htmlFor="temperature">Temperature</label>
              <input
                className="compact-input"
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

          <button type="button" onClick={launchRequestTask} disabled={requestLoading}>Generate Response</button>
          {requestLoading ? (
            <button type="button" className="small-btn" onClick={stopRequestTask}>Stop Generation</button>
          ) : null}
          {requestLoading ? (
            <div className="request-loading-row">
              <span className="request-spinner" aria-hidden="true" />
              <span className="request-loading-text">
                {requestAssignedDonor
                  ? `Computing on ${requestAssignedDonor}'s network...`
                  : "Computing on donor network..."}
              </span>
            </div>
          ) : null}

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
                    <td><span className="room-pill">{getSafeRoomLabel(w.roomId)}</span></td>
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
          <p className="socket-state">Logged in as {authUser?.username || "-"}</p>
          <p className="socket-state">Lifetime $BRAIN: {Number(authUser?.brainEarnings || 0).toFixed(2)}</p>
          <button type="button" className="small-btn" onClick={handleLogout}>Logout</button>

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

          <button type="submit" disabled={authBusy}>{authBusy ? "Please wait..." : mode === "register" ? "Register" : "Login"}</button>
          {authError ? <p className="request-status">{authError}</p> : null}

          <p className="login-text">
            {mode === "register" ? "Already a user? " : "New user? "}
            <button type="button" className="switch-btn" onClick={() => {
              setAuthError("");
              setMode((prev) => (prev === "register" ? "login" : "register"));
            }}>
              {mode === "register" ? "Login" : "Create Account"}
            </button>
          </p>
        </form>
      </section>
    </main>
  );
}

export default App;
