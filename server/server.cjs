const { createServer } = require("http");
const { Server } = require("socket.io");
const { instrument } = require("@socket.io/admin-ui");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const CHUNK_TIMEOUT_MS = Number(process.env.CHUNK_TIMEOUT_MS || 45000);
const MAX_CHUNK_RETRIES = Number(process.env.MAX_CHUNK_RETRIES || 2);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 24 * 30);
const AUTH_STORE_PATH = path.join(__dirname, "data", "auth-store.json");

function ensureAuthStoreFile() {
  const dir = path.dirname(AUTH_STORE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(AUTH_STORE_PATH)) {
    const initial = { users: {}, sessions: {} };
    fs.writeFileSync(AUTH_STORE_PATH, JSON.stringify(initial, null, 2));
  }
}

function loadAuthStore() {
  ensureAuthStoreFile();
  try {
    const raw = fs.readFileSync(AUTH_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      users: parsed?.users && typeof parsed.users === "object" ? parsed.users : {},
      sessions: parsed?.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
    };
  } catch {
    return { users: {}, sessions: {} };
  }
}

let authStore = loadAuthStore();

function saveAuthStore() {
  fs.writeFileSync(AUTH_STORE_PATH, JSON.stringify(authStore, null, 2));
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    brainEarnings: Number(user.brainEarnings || 0),
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

function getUserById(userId) {
  for (const user of Object.values(authStore.users)) {
    if (user.id === userId) return user;
  }
  return null;
}

function createSessionForUser(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  authStore.sessions[token] = {
    userId,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  return token;
}

function cleanupExpiredSessions() {
  const now = Date.now();
  let changed = false;
  for (const [token, session] of Object.entries(authStore.sessions)) {
    if (!session || Number(session.expiresAt || 0) <= now) {
      delete authStore.sessions[token];
      changed = true;
    }
  }
  if (changed) saveAuthStore();
}

cleanupExpiredSessions();
setInterval(cleanupExpiredSessions, 30 * 60 * 1000).unref();

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(payload));
}

function parseRequestUrl(req) {
  return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", (error) => reject(error));
  });
}

function getSessionFromRequest(req) {
  const authHeader = String(req.headers.authorization || "");
  if (!authHeader.startsWith("Bearer ")) return { token: "", session: null, user: null };

  const token = authHeader.slice(7).trim();
  if (!token) return { token: "", session: null, user: null };

  const session = authStore.sessions[token];
  if (!session) return { token, session: null, user: null };

  if (Number(session.expiresAt || 0) <= Date.now()) {
    delete authStore.sessions[token];
    saveAuthStore();
    return { token, session: null, user: null };
  }

  const user = getUserById(session.userId);
  if (!user) {
    delete authStore.sessions[token];
    saveAuthStore();
    return { token, session: null, user: null };
  }

  return { token, session, user };
}

async function handleApiRequest(req, res) {
  const url = parseRequestUrl(req);
  if (!url.pathname.startsWith("/api/")) return false;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end();
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/register") {
    const body = await readJsonBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");

    if (username.length < 3) {
      sendJson(res, 400, { error: "Username must be at least 3 characters." });
      return true;
    }
    if (password.length < 6) {
      sendJson(res, 400, { error: "Password must be at least 6 characters." });
      return true;
    }

    const normalized = normalizeUsername(username);
    if (authStore.users[normalized]) {
      sendJson(res, 409, { error: "Username already exists." });
      return true;
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const nowIso = new Date().toISOString();
    const user = {
      id: `usr_${Date.now()}_${crypto.randomInt(1000, 9999)}`,
      username,
      passwordSalt: salt,
      passwordHash: hashPassword(password, salt),
      brainEarnings: 0,
      createdAt: nowIso,
      lastLoginAt: nowIso,
    };

    authStore.users[normalized] = user;
    const token = createSessionForUser(user.id);
    saveAuthStore();

    sendJson(res, 201, { token, user: toPublicUser(user) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readJsonBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const normalized = normalizeUsername(username);
    const user = authStore.users[normalized];

    if (!user) {
      sendJson(res, 401, { error: "Invalid username or password." });
      return true;
    }

    const expectedHash = hashPassword(password, user.passwordSalt);
    if (expectedHash !== user.passwordHash) {
      sendJson(res, 401, { error: "Invalid username or password." });
      return true;
    }

    user.lastLoginAt = new Date().toISOString();
    authStore.users[normalized] = user;

    const token = createSessionForUser(user.id);
    saveAuthStore();

    sendJson(res, 200, { token, user: toPublicUser(user) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    const { user } = getSessionFromRequest(req);
    if (!user) {
      sendJson(res, 401, { error: "Session invalid or expired." });
      return true;
    }
    sendJson(res, 200, { user: toPublicUser(user) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const { token } = getSessionFromRequest(req);
    if (token && authStore.sessions[token]) {
      delete authStore.sessions[token];
      saveAuthStore();
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/donor/earnings") {
    const { user } = getSessionFromRequest(req);
    if (!user) {
      sendJson(res, 401, { error: "Session invalid or expired." });
      return true;
    }

    const body = await readJsonBody(req);
    const delta = Number(body.delta);
    if (!Number.isFinite(delta) || delta <= 0) {
      sendJson(res, 400, { error: "delta must be a positive number." });
      return true;
    }

    const normalized = normalizeUsername(user.username);
    const dbUser = authStore.users[normalized];
    if (!dbUser) {
      sendJson(res, 404, { error: "User account not found." });
      return true;
    }

    const next = Number((Number(dbUser.brainEarnings || 0) + delta).toFixed(2));
    dbUser.brainEarnings = next;
    authStore.users[normalized] = dbUser;
    saveAuthStore();

    sendJson(res, 200, { user: toPublicUser(dbUser) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/leaderboard") {
    const limitRaw = Number.parseInt(url.searchParams.get("limit"), 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 10;

    const leaderboard = Object.values(authStore.users)
      .map((user) => ({
        id: user.id,
        username: user.username,
        brainEarnings: Number(user.brainEarnings || 0),
      }))
      .sort((a, b) => {
        if (b.brainEarnings !== a.brainEarnings) return b.brainEarnings - a.brainEarnings;
        return a.username.localeCompare(b.username);
      })
      .slice(0, limit)
      .map((user, index) => ({ ...user, rank: index + 1 }));

    sendJson(res, 200, { leaderboard });
    return true;
  }

  sendJson(res, 404, { error: "API route not found." });
  return true;
}

const httpServer = createServer(async (req, res) => {
  try {
    const handled = await handleApiRequest(req, res);
    if (handled) return;

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (error) {
    sendJson(res, 500, { error: error?.message || "Internal server error" });
  }
});

const io = new Server(httpServer, {
  cors: { origin: "*" },
  maxHttpBufferSize: 1e8,
});

instrument(io, {
  auth: false,
  mode: "development",
});

const workers = new Map();
const activeJobs = new Map();
const workerLinks = new Map();
const requestors = new Map();
const admins = new Set();

function broadcastClientStats() {
  const donors = workers.size;
  const idleDonors = Array.from(workers.values()).filter((w) => w.status === "idle").length;
  const busyDonors = Array.from(workers.values()).filter((w) => w.status === "busy").length;

  io.emit("network-clients", {
    donors,
    idleDonors,
    busyDonors,
    requestors: requestors.size,
    admins: admins.size,
    requestorsList: Array.from(requestors.entries()).map(([id, username]) => ({ id, username })),
  });
}

function emitWorkerLinks(workerId) {
  const links = workerLinks.get(workerId) || new Map();
  const receivers = Array.from(links.entries()).map(([receiverId, activeJobsCount]) => ({
    receiverId,
    activeJobsCount,
  }));
  io.to(workerId).emit("worker-links", receivers);
}

function addWorkerLink(workerId, receiverId) {
  if (!workerId || !receiverId) return;
  const links = workerLinks.get(workerId) || new Map();
  links.set(receiverId, (links.get(receiverId) || 0) + 1);
  workerLinks.set(workerId, links);
  emitWorkerLinks(workerId);
}

function removeWorkerLink(workerId, receiverId) {
  if (!workerId || !receiverId) return;
  const links = workerLinks.get(workerId);
  if (!links) return;
  const next = (links.get(receiverId) || 0) - 1;
  if (next <= 0) {
    links.delete(receiverId);
  } else {
    links.set(receiverId, next);
  }
  if (links.size === 0) {
    workerLinks.delete(workerId);
  } else {
    workerLinks.set(workerId, links);
  }
  emitWorkerLinks(workerId);
}

function splitMatrixRows(matrixA, dimension, numChunks) {
  const chunks = [];
  const rowsPerChunk = Math.ceil(dimension / numChunks);

  for (let i = 0; i < numChunks; i += 1) {
    const startRow = i * rowsPerChunk;
    const endRow = Math.min(startRow + rowsPerChunk, dimension);
    if (startRow >= dimension) break;

    const startIdx = startRow * dimension;
    const endIdx = endRow * dimension;
    const chunkData = matrixA.slice(startIdx, endIdx);

    chunks.push({
      chunkId: i,
      rowCount: endRow - startRow,
      data: chunkData,
    });
  }

  return chunks;
}

function getIdleWorkersInRoom(roomId) {
  const idle = [];
  for (const [id, info] of workers) {
    if (info.status === "idle" && info.roomId === roomId) {
      idle.push(id);
    }
  }
  return idle;
}

function getIdleLlmWorkersInRoom(roomId) {
  const idle = [];
  for (const [id, info] of workers) {
    if (info.status === "idle" && info.roomId === roomId && info.llmCapable) {
      idle.push(id);
    }
  }
  return idle;
}

function setWorkerStatus(workerId, status) {
  const info = workers.get(workerId);
  if (!info) return;
  info.status = status;
  workers.set(workerId, info);
}

function clearChunkTimer(chunk) {
  if (chunk.timeout) {
    clearTimeout(chunk.timeout);
    chunk.timeout = null;
  }
}

function finalizeJob(jobId, reason = "completed") {
  const job = activeJobs.get(jobId);
  if (!job) return;

  for (const chunk of job.chunks) {
    clearChunkTimer(chunk);
    if (chunk.assignedWorkerId) {
      removeWorkerLink(chunk.assignedWorkerId, job.fromSocket);
      setWorkerStatus(chunk.assignedWorkerId, "idle");
      chunk.assignedWorkerId = null;
    }
  }

  activeJobs.delete(jobId);
  broadcastNetworkStatus();

  io.to("admins").emit("admin-activity", {
    time: new Date().toLocaleTimeString(),
    msg: `Job ${jobId} ${reason}`,
  });
}

function failJob(jobId, message) {
  const job = activeJobs.get(jobId);
  if (!job) return;

  io.to(job.fromSocket).emit("job-status", {
    status: "Failed",
    msg: message,
  });

  io.to("admins").emit("admin-activity", {
    time: new Date().toLocaleTimeString(),
    msg: `Job failed (${jobId}): ${message}`,
  });

  finalizeJob(jobId, "failed");
}

function completeJobIfReady(jobId) {
  const job = activeJobs.get(jobId);
  if (!job || job.receivedChunks !== job.totalChunks) return;

  const finalResult =
    job.jobType === "llm_generate"
      ? job.results[0] || { text: "No result returned." }
      : job.results.flat();

  io.to(job.fromSocket).emit("job-finished", finalResult);

  io.to("admins").emit("admin-activity", {
    time: new Date().toLocaleTimeString(),
    msg: `Job finished: "${job.task}" in ${Date.now() - job.startTime}ms`,
  });

  finalizeJob(jobId);
}

function assignChunkToWorker(jobId, chunkId, workerId) {
  const job = activeJobs.get(jobId);
  const chunk = job?.chunks[chunkId];
  if (!job || !chunk || chunk.status === "done") return false;

  const worker = workers.get(workerId);
  if (!worker || worker.status !== "idle") return false;
  if (job.jobType === "llm_generate" && !worker.llmCapable) return false;

  if (chunk.assignedWorkerId) {
    removeWorkerLink(chunk.assignedWorkerId, job.fromSocket);
  }

  chunk.status = "assigned";
  chunk.assignedWorkerId = workerId;
  chunk.attempts += 1;

  setWorkerStatus(workerId, "busy");
  addWorkerLink(workerId, job.fromSocket);

  clearChunkTimer(chunk);
  chunk.timeout = setTimeout(() => {
    const freshJob = activeJobs.get(jobId);
    const freshChunk = freshJob?.chunks[chunkId];
    if (!freshJob || !freshChunk || freshChunk.status !== "assigned") return;

    const timedOutWorker = freshChunk.assignedWorkerId;
    if (timedOutWorker) {
      removeWorkerLink(timedOutWorker, freshJob.fromSocket);
      setWorkerStatus(timedOutWorker, "idle");
    }

    freshChunk.assignedWorkerId = null;
    freshChunk.status = "pending";

    io.to(freshJob.fromSocket).emit("job-status", {
      status: "Retrying",
      msg: `Worker timeout on chunk ${chunkId + 1}. Retrying...`,
    });

    dispatchPendingChunks(jobId);
  }, CHUNK_TIMEOUT_MS);

  io.to(workerId).emit("compute-task", {
    ...chunk.dispatchPayload,
    jobId,
    chunkId,
    from: job.fromSocket,
  });

  return true;
}

function dispatchPendingChunks(jobId) {
  const job = activeJobs.get(jobId);
  if (!job) return;

  for (const chunk of job.chunks) {
    if (chunk.status !== "pending") continue;

    if (chunk.attempts > MAX_CHUNK_RETRIES) {
      failJob(jobId, `Retry budget exhausted for chunk ${chunk.chunkId + 1}.`);
      return;
    }

    const idleWorkers =
      job.jobType === "llm_generate"
        ? getIdleLlmWorkersInRoom(job.roomId)
        : getIdleWorkersInRoom(job.roomId);

    if (!idleWorkers.length) {
      io.to(job.fromSocket).emit("job-status", {
        status: "Queued",
        msg: `Waiting for available workers in Room: ${job.roomId}`,
      });
      continue;
    }

    assignChunkToWorker(jobId, chunk.chunkId, idleWorkers[0]);
  }

  broadcastNetworkStatus();
}

function dispatchAllPendingJobs() {
  for (const jobId of activeJobs.keys()) {
    dispatchPendingChunks(jobId);
  }
}

function retryChunksForWorker(workerId) {
  for (const [jobId, job] of activeJobs) {
    let changed = false;

    for (const chunk of job.chunks) {
      if (chunk.assignedWorkerId !== workerId || chunk.status !== "assigned") continue;

      clearChunkTimer(chunk);
      removeWorkerLink(workerId, job.fromSocket);
      chunk.assignedWorkerId = null;
      chunk.status = "pending";
      changed = true;
    }

    if (changed) {
      io.to(job.fromSocket).emit("job-status", {
        status: "Retrying",
        msg: "Assigned worker disconnected. Reassigning workload...",
      });
      dispatchAllPendingJobs();
    }
  }
}

io.on("connection", (socket) => {
  console.log("Connection:", socket.id);

  socket.on("register-admin", () => {
    socket.join("admins");
    admins.add(socket.id);
    broadcastNetworkStatus();
    broadcastClientStats();
    console.log("Admin connected:", socket.id);
  });

  socket.on("register-requestor", (payload = {}) => {
    const username = String(payload.username || "").trim();
    requestors.set(socket.id, username || `user-${socket.id.slice(0, 6)}`);
    broadcastClientStats();
  });

  socket.on("register-worker", (payload = {}) => {
    const {
      hasWebGPU = false,
      gpuName = "Unknown",
      roomId = "public",
      llmCapable = false,
      username = "",
    } = payload;

    socket.join(roomId);
    workers.set(socket.id, { hasWebGPU, gpuName, llmCapable, status: "idle", roomId, username: String(username || "").trim() });
    workerLinks.set(socket.id, new Map());
    emitWorkerLinks(socket.id);

    dispatchAllPendingJobs();

    console.log(`Worker Joined Room [${roomId}]: ${gpuName} (${socket.id})`);
    broadcastNetworkStatus();
    broadcastClientStats();
  });

  socket.on("disconnect", () => {
    requestors.delete(socket.id);
    admins.delete(socket.id);

    if (workers.has(socket.id)) {
      retryChunksForWorker(socket.id);
      workers.delete(socket.id);
      workerLinks.delete(socket.id);
      console.log("Worker Disconnected:", socket.id);
      broadcastNetworkStatus();
    }

    broadcastClientStats();
  });

  socket.on("request-matrix-job", (payload = {}) => {
    const {
      task = "Unknown Task",
      roomId = "public",
      matrixA = [],
      matrixB = [],
      dimension = 0,
    } = payload;

    console.log(`Job Request for Room [${roomId}]: "${task}"`);

    io.to("admins").emit("admin-activity", {
      time: new Date().toLocaleTimeString(),
      msg: `User (${socket.id.slice(0, 4)}...) requested: ${task} in [${roomId}]`,
    });

    const jobId = `job_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    if (payload.type === "llm_generate") {
      activeJobs.set(jobId, {
        id: jobId,
        fromSocket: socket.id,
        roomId,
        task,
        jobType: "llm_generate",
        startTime: Date.now(),
        totalChunks: 1,
        receivedChunks: 0,
        results: [null],
        chunks: [
          {
            chunkId: 0,
            status: "pending",
            attempts: 0,
            assignedWorkerId: null,
            timeout: null,
            dispatchPayload: {
              ...payload,
              taskType: "llm_generate",
            },
          },
        ],
      });

      dispatchPendingChunks(jobId);

      socket.emit("job-status", {
        status: "Assigned",
        msg: "LLM request queued for fault-tolerant dispatch.",
      });
      return;
    }

    const idleWorkers = getIdleWorkersInRoom(roomId);
    if (!idleWorkers.length) {
      socket.emit("job-status", {
        status: "Queued",
        msg: `No idle workers in Room: ${roomId}`,
      });
      io.to("admins").emit("admin-activity", {
        time: new Date().toLocaleTimeString(),
        msg: `Queued: no workers in [${roomId}] for User (${socket.id.slice(0, 4)}...)`,
      });
      return;
    }

    const safeDimension = Math.max(1, Number.parseInt(dimension, 10) || 0);
    const matrixChunks = splitMatrixRows(matrixA, safeDimension, idleWorkers.length);

    if (!matrixChunks.length) {
      socket.emit("job-status", {
        status: "Failed",
        msg: "Invalid matrix payload. Could not create work chunks.",
      });
      return;
    }

    activeJobs.set(jobId, {
      id: jobId,
      fromSocket: socket.id,
      roomId,
      task,
      jobType: payload.type || "matrix",
      startTime: Date.now(),
      totalChunks: matrixChunks.length,
      receivedChunks: 0,
      results: new Array(matrixChunks.length),
      chunks: matrixChunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        status: "pending",
        attempts: 0,
        assignedWorkerId: null,
        timeout: null,
        dispatchPayload: {
          task,
          type: payload.type || "matrix",
          matrixA: chunk.data,
          matrixB,
          dimension: safeDimension,
          rowCount: chunk.rowCount,
          roomId,
        },
      })),
    });

    dispatchPendingChunks(jobId);

    io.to("admins").emit("admin-activity", {
      time: new Date().toLocaleTimeString(),
      msg: `Distributed "${task}" into ${matrixChunks.length} chunks in [${roomId}]`,
    });
    socket.emit("job-status", {
      status: "Assigned",
      msg: `Distributed to ${matrixChunks.length} worker nodes with retries enabled.`,
    });
  });

  socket.on("compute-result", ({ jobId, chunkId, result, computeTimeMs, from, taskType } = {}) => {
    const parsedChunkId = Number.isInteger(chunkId) ? chunkId : Number.parseInt(chunkId, 10) || 0;
    const job = activeJobs.get(jobId);

    if (job) {
      const chunk = job.chunks[parsedChunkId];

      if (!chunk || chunk.status !== "assigned" || chunk.assignedWorkerId !== socket.id) {
        return;
      }

      clearChunkTimer(chunk);
      removeWorkerLink(socket.id, job.fromSocket);

      chunk.status = "done";
      chunk.assignedWorkerId = null;

      job.results[parsedChunkId] = result;
      job.receivedChunks += 1;

      io.to("admins").emit("admin-activity", {
        time: new Date().toLocaleTimeString(),
        msg:
          taskType === "llm_generate" || (result && typeof result === "object" && "text" in result)
            ? `LLM response received (${computeTimeMs || "?"}ms)`
            : `Chunk ${parsedChunkId + 1} received (${computeTimeMs || "?"}ms)`,
      });

      setWorkerStatus(socket.id, "idle");
      dispatchAllPendingJobs();
      completeJobIfReady(jobId);
      return;
    }

    if (from && !jobId) {
      removeWorkerLink(socket.id, from);
      io.to(from).emit("job-finished", result);
      setWorkerStatus(socket.id, "idle");
      dispatchAllPendingJobs();
      broadcastNetworkStatus();
    }
  });
});

function broadcastNetworkStatus() {
  const list = Array.from(workers.entries()).map(([id, data]) => ({ id, ...data }));
  io.emit("network-status", list);
  broadcastClientStats();
}

httpServer.listen(PORT, HOST, () => {
  console.log(`Orchestrator running at http://localhost:${PORT}`);
});
