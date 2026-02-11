const { createServer } = require("http");
const { Server } = require("socket.io");
const { instrument } = require("@socket.io/admin-ui");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

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
      startRow,
      endRow,
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
    console.log(`Worker Joined Room [${roomId}]: ${gpuName} (${socket.id})`);
    broadcastNetworkStatus();
  });

  socket.on("disconnect", () => {
    if (workers.has(socket.id)) {
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

    const idleWorkers = getIdleWorkersInRoom(roomId);

    if (payload.type === "llm_generate") {
      const selectedWorker = getIdleLlmWorkersInRoom(roomId)[0];
      if (!selectedWorker) {
        socket.emit("job-status", {
          status: "Queued",
          msg: `No idle LLM-capable workers in Room: ${roomId}`,
        });
        io.to("admins").emit("admin-activity", {
          time: new Date().toLocaleTimeString(),
          msg: `Failed LLM request: no workers in [${roomId}]`,
        });
        return;
      }

      const info = workers.get(selectedWorker);
      if (info) {
        info.status = "busy";
        workers.set(selectedWorker, info);
      }

      broadcastNetworkStatus();
      socket.emit("job-status", {
        status: "Assigned",
        msg: `LLM request assigned to worker ${selectedWorker.slice(0, 6)}...`,
      });
      addWorkerLink(selectedWorker, socket.id);
      io.to(selectedWorker).emit("compute-task", {
        ...payload,
        taskType: "llm_generate",
        from: socket.id,
      });
      io.to("admins").emit("admin-activity", {
        time: new Date().toLocaleTimeString(),
        msg: `Assigned LLM request to Worker (${selectedWorker.slice(0, 4)}...) in [${roomId}]`,
      });
      return;
    }

    if (!idleWorkers.length) {
      socket.emit("job-status", {
        status: "Queued",
        msg: `No idle workers in Room: ${roomId}`,
      });
      io.to("admins").emit("admin-activity", {
        time: new Date().toLocaleTimeString(),
        msg: `Failed: no workers in [${roomId}] for User (${socket.id.slice(0, 4)}...)`,
      });
      return;
    }

    const safeDimension = Math.max(1, Number.parseInt(dimension, 10) || 0);
    const chunks = splitMatrixRows(matrixA, safeDimension, idleWorkers.length);
    const jobId = `job_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    activeJobs.set(jobId, {
      fromSocket: socket.id,
      totalChunks: chunks.length,
      receivedChunks: 0,
      results: new Array(chunks.length),
      startTime: Date.now(),
      task,
    });

    chunks.forEach((chunk, index) => {
      const workerId = idleWorkers[index];
      const info = workers.get(workerId);
      if (info) {
        info.status = "busy";
        workers.set(workerId, info);
      }

      io.to(workerId).emit("compute-task", {
        jobId,
        chunkId: chunk.chunkId,
        task,
        type: payload.type || "matrix",
        matrixA: chunk.data,
        matrixB,
        dimension: safeDimension,
        rowCount: chunk.rowCount,
        roomId,
        from: socket.id,
      });
      addWorkerLink(workerId, socket.id);
    });

    broadcastNetworkStatus();
    io.to("admins").emit("admin-activity", {
      time: new Date().toLocaleTimeString(),
      msg: `Distributed "${task}" into ${chunks.length} chunks in [${roomId}]`,
    });
    socket.emit("job-status", {
      status: "Assigned",
      msg: `Distributed to ${chunks.length} worker nodes.`,
    });
  });

  socket.on("compute-result", ({ jobId, chunkId, result, computeTimeMs, from, taskType } = {}) => {
    const job = activeJobs.get(jobId);

    if (job) {
      job.results[chunkId] = Array.isArray(result) ? result : [];
      job.receivedChunks += 1;
      removeWorkerLink(socket.id, job.fromSocket);
    }

    if (workers.has(socket.id)) {
      const info = workers.get(socket.id);
      info.status = "idle";
      workers.set(socket.id, info);
      broadcastNetworkStatus();
    }

    io.to("admins").emit("admin-activity", {
      time: new Date().toLocaleTimeString(),
      msg:
        taskType === "llm_generate" || (result && typeof result === "object" && "text" in result)
          ? `LLM response received (${computeTimeMs || "?"}ms)`
          : `Chunk ${Number(chunkId) + 1 || "?"} received (${computeTimeMs || "?"}ms)`,
    });

    if (job && job.receivedChunks === job.totalChunks) {
      const finalResult = job.results.flat();
      io.to(job.fromSocket).emit("job-finished", finalResult);

      io.to("admins").emit("admin-activity", {
        time: new Date().toLocaleTimeString(),
        msg: `Job finished: "${job.task}" in ${Date.now() - job.startTime}ms`,
      });

      activeJobs.delete(jobId);
      return;
    }

    if (from && !jobId) {
      removeWorkerLink(socket.id, from);
      io.to(from).emit("job-finished", result);
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
