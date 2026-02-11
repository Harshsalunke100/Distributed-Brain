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

function clearWorkerTask(workerId) {
  const info = workers.get(workerId);
  if (!info) return;
  info.status = "idle";
  info.currentTask = null;
  workers.set(workerId, info);
}

function getEligibleWorker(job) {
  const candidates = job.type === "llm_generate"
    ? getIdleLlmWorkersInRoom(job.roomId)
    : getIdleWorkersInRoom(job.roomId);
  return candidates[0] || null;
}

function assignJobToWorker(jobId, workerId, isReassignment = false) {
  const job = activeJobs.get(jobId);
  if (!job) return false;

  const info = workers.get(workerId);
  if (!info || info.status !== "idle" || info.roomId !== job.roomId) return false;

  info.status = "busy";
  info.currentTask = { jobId };
  workers.set(workerId, info);

  job.assignedWorker = workerId;
  job.assignedAt = Date.now();
  activeJobs.set(jobId, job);

  io.to(workerId).emit("compute-task", { ...job.payload, jobId, from: job.fromSocket });
  addWorkerLink(workerId, job.fromSocket);

  if (isReassignment) {
    io.to(job.fromSocket).emit("job-status", {
      status: "Assigned",
      msg: `FR-005: Worker failover complete. Reassigned to ${workerId.slice(0, 6)}...`,
    });
    io.to("admins").emit("admin-activity", {
      time: new Date().toLocaleTimeString(),
      msg: `FR-005: Reassigned "${job.task}" to worker ${workerId.slice(0, 6)}...`,
    });
  }

  return true;
}

function dispatchQueuedJobsForRoom(roomId) {
  for (const [jobId, job] of activeJobs) {
    if (job.roomId !== roomId || job.assignedWorker) continue;
    const nextWorker = getEligibleWorker(job);
    if (nextWorker) {
      assignJobToWorker(jobId, nextWorker, true);
    }
  }
  broadcastNetworkStatus();
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
    workers.set(socket.id, {
      hasWebGPU,
      gpuName,
      llmCapable,
      status: "idle",
      roomId,
      currentTask: null,
    });
    workerLinks.set(socket.id, new Map());
    emitWorkerLinks(socket.id);
    console.log(`Worker Joined Room [${roomId}]: ${gpuName} (${socket.id})`);
    broadcastNetworkStatus();
    setTimeout(() => dispatchQueuedJobsForRoom(roomId), 0);
  });

  socket.on("disconnect", () => {
    const info = workers.get(socket.id);
    if (info) {
      const assignedTask = info.currentTask;
      workers.delete(socket.id);
      workerLinks.delete(socket.id);
      console.log("Worker Disconnected:", socket.id);
      broadcastNetworkStatus();

      if (assignedTask) {
        const { jobId } = assignedTask;
        const job = activeJobs.get(jobId);
        if (job && job.assignedWorker === socket.id) {
          job.assignedWorker = null;
          job.assignedAt = null;
          activeJobs.set(jobId, job);
          removeWorkerLink(socket.id, job.fromSocket);

          io.to("admins").emit("admin-activity", {
            time: new Date().toLocaleTimeString(),
            msg: `FR-005: Worker ${socket.id.slice(0, 6)}... disconnected during "${job.task}".`,
          });

          const replacement = getEligibleWorker(job);
          if (replacement) {
            setTimeout(() => assignJobToWorker(jobId, replacement, true), 0);
          } else {
            io.to(job.fromSocket).emit("job-status", {
              status: "Queued",
              msg: "FR-005: Worker disconnected. Waiting for another eligible worker...",
            });
            io.to("admins").emit("admin-activity", {
              time: new Date().toLocaleTimeString(),
              msg: `FR-005: No replacement worker yet for "${job.task}" in [${job.roomId}].`,
            });
          }
        }
      }
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

      const jobId = `job_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      activeJobs.set(jobId, {
        fromSocket: socket.id,
        startTime: Date.now(),
        task,
        roomId,
        type: "llm_generate",
        assignedWorker: null,
        assignedAt: null,
        payload: {
          ...payload,
          taskType: "llm_generate",
          roomId,
        },
      });
      assignJobToWorker(jobId, selectedWorker, false);

      broadcastNetworkStatus();
      socket.emit("job-status", {
        status: "Assigned",
        msg: `LLM request assigned to worker ${selectedWorker.slice(0, 6)}...`,
      });
      io.to("admins").emit("admin-activity", {
        time: new Date().toLocaleTimeString(),
        msg: `Assigned LLM request to Worker (${selectedWorker.slice(0, 4)}...) in [${roomId}]`,
      });
      return;
    }

    const selectedWorker = getIdleWorkersInRoom(roomId)[0];
    if (!selectedWorker) {
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
    const jobId = `job_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    activeJobs.set(jobId, {
      fromSocket: socket.id,
      startTime: Date.now(),
      task,
      type: "matrix",
      roomId,
      assignedWorker: null,
      assignedAt: null,
      payload: {
        ...payload,
        type: "matrix",
        matrixA,
        matrixB,
        dimension: safeDimension,
        rowCount: safeDimension,
        roomId,
      },
    });
    assignJobToWorker(jobId, selectedWorker, false);

    broadcastNetworkStatus();
    io.to("admins").emit("admin-activity", {
      time: new Date().toLocaleTimeString(),
      msg: `Assigned "${task}" to worker ${selectedWorker.slice(0, 6)}... in [${roomId}]`,
    });
    socket.emit("job-status", {
      status: "Assigned",
      msg: `Assigned to worker ${selectedWorker.slice(0, 6)}...`,
    });
  });

  socket.on("compute-result", ({ jobId, chunkId, result, computeTimeMs, from, taskType } = {}) => {
    const job = activeJobs.get(jobId);

    if (job) {
      if (job.assignedWorker !== socket.id) {
        io.to("admins").emit("admin-activity", {
          time: new Date().toLocaleTimeString(),
          msg: `Ignored stale result from worker ${socket.id.slice(0, 6)}...`,
        });
      } else {
        removeWorkerLink(socket.id, job.fromSocket);
        io.to(job.fromSocket).emit("job-finished", result);
        io.to("admins").emit("admin-activity", {
          time: new Date().toLocaleTimeString(),
          msg: `Job finished: "${job.task}" in ${Date.now() - job.startTime}ms`,
        });
        activeJobs.delete(jobId);
      }
    }

    if (workers.has(socket.id)) {
      clearWorkerTask(socket.id);
      const roomId = workers.get(socket.id)?.roomId || "public";
      broadcastNetworkStatus();
      setTimeout(() => dispatchQueuedJobsForRoom(roomId), 0);
    }

    io.to("admins").emit("admin-activity", {
      time: new Date().toLocaleTimeString(),
      msg:
        taskType === "llm_generate" || (result && typeof result === "object" && "text" in result)
          ? `LLM response received (${computeTimeMs || "?"}ms)`
          : `Result received (${computeTimeMs || "?"}ms)`,
    });

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
