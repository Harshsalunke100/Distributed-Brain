const { createServer } = require("http");
const { Server } = require("socket.io");
const { instrument } = require("@socket.io/admin-ui");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const CHUNK_TIMEOUT_MS = Number(process.env.CHUNK_TIMEOUT_MS || 45000);
const MAX_CHUNK_RETRIES = Number(process.env.MAX_CHUNK_RETRIES || 2);

const httpServer = createServer();
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
    broadcastNetworkStatus();
    console.log("Admin connected:", socket.id);
  });

  socket.on("register-worker", (payload = {}) => {
    const {
      hasWebGPU = false,
      gpuName = "Unknown",
      roomId = "public",
      llmCapable = false,
    } = payload;

    socket.join(roomId);
    workers.set(socket.id, { hasWebGPU, gpuName, llmCapable, status: "idle", roomId });
    workerLinks.set(socket.id, new Map());
    emitWorkerLinks(socket.id);

    dispatchAllPendingJobs();

    console.log(`Worker Joined Room [${roomId}]: ${gpuName} (${socket.id})`);
    broadcastNetworkStatus();
  });

  socket.on("disconnect", () => {
    if (workers.has(socket.id)) {
      retryChunksForWorker(socket.id);
      workers.delete(socket.id);
      workerLinks.delete(socket.id);
      console.log("Worker Disconnected:", socket.id);
      broadcastNetworkStatus();
    }
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
}

httpServer.listen(PORT, HOST, () => {
  console.log(`Orchestrator running at http://localhost:${PORT}`);
});
