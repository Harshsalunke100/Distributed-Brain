# Distributed Brain Frontend

A Vite + React application for a browser-based distributed compute network.  
Users can join as:

- `Donator (Worker)`: contributes browser compute and handles matrix/LLM tasks.
- `Requestor (User)`: submits LLM prompts to available workers.
- `Server (Admin)`: monitors worker status and job activity in real time.

The frontend communicates with a local Socket.IO orchestrator in `server/server.cjs`.

## Tech Stack

- React 18
- Vite 5
- Socket.IO / Socket.IO Client
- WebLLM (`@mlc-ai/web-llm`) for in-browser LLM inference on donor nodes

## Project Structure

```text
.
|-- server/
|   `-- server.cjs         # Socket.IO orchestrator
|-- src/
|   |-- App.jsx            # Role flows: auth, donor, requestor, admin
|   |-- main.jsx
|   `-- index.css
|-- .env                   # Frontend runtime env vars
|-- package.json
`-- vite.config.js
```

## Prerequisites

- Node.js 18+
- npm 9+
- A modern Chromium-based browser for best WebGPU/WebLLM support

## Environment Variables

Create or update `.env`:

```bash
VITE_SOCKET_URL=http://localhost:3000
```

If your server runs on another device/IP, set that URL accordingly.

## Install

```bash
npm install
```

## Run Locally

Start backend orchestrator:

```bash
npm run server
```

Start frontend (in a second terminal):

```bash
npm run dev
```

Open the Vite URL (usually `http://localhost:5173`).

## Available Scripts

- `npm run dev` - start Vite dev server
- `npm run server` - start Socket.IO orchestrator (`server/server.cjs`)
- `npm run build` - production build
- `npm run preview` - preview production build locally

## How to Use

1. Open the app and continue through the auth screen.
2. Select a role:
   - `Donator`: join `public` or a private room code and contribute compute.
   - `Requestor`: submit prompts to `public` room or a private donor room.
   - `Server`: view worker table and live activity logs.
3. For end-to-end testing, open multiple browser tabs/windows:
   - one as Donator
   - one as Requestor
   - optionally one as Server/Admin

## Notes

- LLM tasks are routed only to workers marked `llmCapable`.
- If no compatible idle worker is available in the selected room, requests stay queued.
- Default model in the UI is `Qwen2.5-0.5B-Instruct-q4f16_1-MLC`.
