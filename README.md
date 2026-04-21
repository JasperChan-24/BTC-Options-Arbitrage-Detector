# BTC Options Arbitrage Detector

A full-stack, real-time Bitcoin options arbitrage detection and execution system. The platform continuously monitors **OKX** and **Deribit** options markets via WebSocket, identifies mathematically guaranteed risk-free profit opportunities using **Linear Programming (LP)**, and optionally auto-executes trades on testnet environments — all accessible from any device through a responsive web dashboard.

---

## ✨ Key Features

### 🔍 Real-Time Arbitrage Detection
- Dual-exchange support: **OKX** (Real + Paper Trading) and **Deribit** (Mainnet + Testnet)
- **4 parallel market engines** running simultaneously — arbitrage is detected across all environments regardless of UI selection
- Sub-second detection via persistent **WebSocket connections** (not REST polling)
- LP solver scans the entire volatility surface every 500ms per market

### ⚡ Automated Execution
- One-click manual execution or fully **autonomous auto-execute mode** on testnet
- OKX execution via private WebSocket API for lowest latency
- Deribit execution via authenticated REST API
- Per-order fill tracking with real-time status updates (pending → live → filled)
- Configurable **risk budget** (% of account balance) with per-exchange sizing

### 📊 Advanced Visualization
- **Convexity Chart**: Visualizes call/put bid-ask curves across strikes to spot pricing anomalies
- **Payoff Diagram**: Renders the P&L profile of the detected optimal portfolio across all underlying prices
- **Live Options Table**: Full chain data with real-time bid/ask, volume, spread, and Greeks
- **Execution Drawer**: Historical log of all detected and executed arbitrage events

### 🧪 Demo / Stress-Test Mode
- Inject artificial pricing anomalies by applying percentage adjustments to individual bid/ask quotes
- Frontend LP solver runs independently — modifications persist without being overwritten by live data
- Test the detection algorithm without risking capital

### 🌐 Multi-Environment Architecture
- Seamlessly switch between **Real** and **Testnet** environments from the UI
- Real markets: **detect-only mode** — opportunities are logged and displayed, never executed
- Testnet markets: full detection + auto-execution + email notifications
- All execution records are persisted to JSONL regardless of environment

### 🔔 Notifications & Monitoring
- **Email alerts** via SMTP when arbitrage is detected (configurable)
- System health indicators: WebSocket connection status, data staleness warnings, backend heartbeat
- HTTP Basic Auth protection for cloud deployments

### 🌍 Cloud Deployment
- **Docker Compose** orchestration (backend + frontend + Nginx reverse proxy)
- Runs 24/7 on any VPS — continues detecting and executing even when your laptop is off
- Access the dashboard from any device via browser

---

## 🧮 Arbitrage Detection: Mathematical Foundation

The core engine translates the theoretical **No-Arbitrage Condition** into a Linear Programming problem. A static arbitrage exists if we can construct a portfolio with a **strictly positive initial cash flow** while guaranteeing a **non-negative payoff** at expiry for all possible underlying prices $S_T$.

### Objective Function

Maximize initial profit by buying at Ask and selling at Bid:

$$
\text{Maximize} \quad Z = \sum_{i} \left( y_i \cdot \text{Bid}_i - x_i \cdot \text{Ask}_i \right)
$$

where $x_i$ and $y_i$ are the buy/sell quantities for option $i$, bounded by a configurable BTC budget.

### Constraint Structure

The LP ensures global non-negativity of the payoff function via three constraint sets:

| Constraint | Condition | Purpose |
|---|---|---|
| **Left boundary** | $\text{Payoff}(S_T = 0) \geq 0$ | Portfolio safe if BTC goes to zero |
| **Kink points** | $\text{Payoff}(K_j) \geq 0 \quad \forall$ strikes $K_j$ | Non-negative at every strike node |
| **Right slope** | $\lim_{S_T \to \infty} \text{slope} \geq 0$ | No negative divergence |

Since European option payoffs are piecewise linear, these three conditions are **necessary and sufficient** for global non-negativity — no Monte Carlo simulation needed.

### Dual Implementation

The LP solver is implemented in **both** the frontend and backend:
- **Frontend** (`javascript-lp-solver`): Used in Demo Mode for instant local computation
- **Backend** (`scipy.optimize.linprog`): Runs continuously on all 4 market engines for production detection

---

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      React Frontend                         │
│  ┌───────────┐  ┌──────────┐  ┌───────────┐  ┌───────────┐  │
│  │ Dashboard │  │ Options  │  │ Convexity │  │ Execution │  │
│  │  + Demo   │  │  Table   │  │ + Payoff  │  │  Drawer   │  │
│  └───────────┘  └──────────┘  └───────────┘  └───────────┘  │
│          │ Zustand Store │          SSE Stream ↑            │
└──────────┼───────────────┼─────────────────────┘────────────┘
           │               │                     │
           ▼               ▼                     │
┌─────────────────────────────────────────────────────────────┐
│                    Python Backend (FastAPI)                 │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              Arbitrage Engine (LP Solver)             │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │  │
│  │  │ OKX Real │ │OKX Paper │ │ Deribit  │ │ Deribit  │  │  │
│  │  │          │ │          │ │  Real    │ │ Testnet  │  │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─────────────┐ ┌──────────────┐ ┌────────────────────┐    │
│  │ WsEngine    │ │ Trading Svc  │ │ Email Notifier     │    │
│  │ (OKX WS)    │ │ (OKX + Deri) │ │ (SMTP)             │    │
│  ├─────────────┤ ├──────────────┤ ├────────────────────┤    │
│  │ DeribitWs   │ │ Execution    │ │ SSE Manager        │    │
│  │ Engine      │ │ Store (JSONL)│ │ (Server→Client)    │    │
│  └─────────────┘ └──────────────┘ └────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
           │                    │
           ▼                    ▼
    ┌──────────────┐   ┌──────────────┐
    │   OKX API    │   │ Deribit API  │
    │  (WebSocket) │   │ (WebSocket)  │
    └──────────────┘   └──────────────┘
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 19, TypeScript, Vite |
| **State Management** | Zustand |
| **Styling** | Tailwind CSS 4, Lucide React Icons |
| **Charts** | Recharts (SVG) |
| **Animations** | Motion (Framer Motion) |
| **Frontend LP** | javascript-lp-solver |
| **Backend** | Python 3.11+, FastAPI, Uvicorn |
| **Backend LP** | SciPy (linprog) |
| **Real-Time** | WebSocket (OKX/Deribit), Server-Sent Events (SSE) |
| **Data Models** | Pydantic v2 |
| **Persistence** | JSONL (append-only execution log) |
| **Email** | aiosmtplib (async SMTP) |
| **Deployment** | Docker, Docker Compose, Nginx |
| **Auth** | HTTP Basic Auth (Nginx) |
| **i18n** | Built-in English / 中文 |

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** v18+ (for frontend)
- **Python** 3.11+ (for backend)
- **Docker** & **Docker Compose** (for production deployment)

### 1. Clone & Install

```bash
git clone https://github.com/JasperChan-24/BTC-Options-Arbitrage-Detector.git
cd BTC-Options-Arbitrage-Detector

# Frontend
npm install

# Backend
pip install -r server_py/requirements.txt
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your API credentials:

```env
# ── OKX API Credentials ──
OKX_API_KEY=your_api_key
OKX_SECRET_KEY=your_secret_key
OKX_PASSPHRASE=your_passphrase
OKX_SIMULATED=true          # true = Paper Trading, false = Real

# ── Deribit API Credentials ──
DERIBIT_CLIENT_ID=your_client_id
DERIBIT_CLIENT_SECRET=your_client_secret
DERIBIT_TESTNET=true         # true = Testnet, false = Mainnet

# ── Server Config ──
SERVER_PORT=3001

# ── Email Notifications (optional) ──
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password
NOTIFY_EMAIL=recipient@example.com
```

> **Note:** API credentials can also be set at runtime via the frontend's API Key panel.

### 3. Run Locally (Development)

```bash
# Terminal 1 — Start backend
python -m uvicorn server_py.main:app --host 0.0.0.0 --port 3001 --reload

# Terminal 2 — Start frontend
npm run dev
```

Or run both concurrently:

```bash
npm run dev:all
```

Open `http://localhost:3000` in your browser.

---

## 🐳 Production Deployment (Docker)

### 1. Set Up Authentication

```bash
# Create HTTP Basic Auth password file
apt-get install -y apache2-utils   # if htpasswd not available
htpasswd -c .htpasswd your_username
```

### 2. Deploy

```bash
docker-compose up -d --build
```

This starts:
- **`btc-arb-backend`** — Python FastAPI server on port 3001
- **`btc-arb-frontend`** — Nginx serving the React build on port 80

### 3. Update After Code Changes

```bash
git pull
docker-compose down && docker-compose up -d --build
```

### 4. Monitor Logs

```bash
docker logs -f btc-arb-backend    # Backend logs
docker logs -f btc-arb-frontend   # Nginx access logs
```

---

## 📂 Project Structure

```
.
├── src/                              # React Frontend
│   ├── components/
│   │   ├── Dashboard.tsx             # Main orchestrator (state, hooks, layout)
│   │   ├── ApiKeyPanel.tsx           # Exchange credential management
│   │   ├── OrderPanel.tsx            # Manual order placement
│   │   └── dashboard/
│   │       ├── SettingsBar.tsx       # Exchange selector, filters, environment toggle
│   │       ├── ArbitrageStatus.tsx   # Arbitrage result display + execute button
│   │       ├── ConvexityChart.tsx    # Call/Put bid-ask curve visualization
│   │       ├── PayoffChart.tsx       # Portfolio payoff diagram
│   │       ├── OptionsTable.tsx      # Live options chain table
│   │       ├── DemoModePanel.tsx     # Price modification sandbox
│   │       └── ExecutionDrawer.tsx   # Historical execution log
│   ├── hooks/
│   │   ├── useBackendSSE.ts          # SSE connection + event handler
│   │   ├── useLiveDataBuffer.ts      # Buffered option data commits
│   │   ├── useBalance.ts             # Account balance polling
│   │   └── useSettings.ts            # Config sync with backend
│   ├── services/
│   │   ├── arbitrageService.ts       # Frontend LP solver (Demo Mode)
│   │   ├── backendApi.ts             # REST API client
│   │   ├── okxService.ts             # OKX REST data fetcher
│   │   ├── okxTradingService.ts      # OKX order execution
│   │   ├── deribitService.ts         # Deribit REST data fetcher
│   │   └── deribitTradingService.ts  # Deribit order execution
│   ├── store/
│   │   └── useAppStore.ts            # Zustand global state
│   ├── config/                       # API base URL configuration
│   ├── i18n.ts                       # Bilingual translations (EN/CN)
│   └── types.ts                      # TypeScript type definitions
│
├── server_py/                        # Python Backend
│   ├── main.py                       # FastAPI app + 4 WsEngine lifecycle
│   ├── routes.py                     # REST + SSE API endpoints
│   ├── arbitrage_engine.py           # Core LP engine + execution orchestrator
│   ├── arbitrage_service.py          # SciPy LP solver (linprog)
│   ├── ws_engine.py                  # OKX WebSocket connection manager
│   ├── deribit_ws_engine.py          # Deribit WebSocket connection manager
│   ├── okx_ws_trader.py              # OKX private WS for order placement
│   ├── trading_service.py            # OKX REST trading service
│   ├── deribit_trading_service.py    # Deribit REST trading service
│   ├── sse_manager.py                # Server-Sent Events broadcaster
│   ├── execution_store.py            # JSONL persistent execution log
│   ├── email_notifier.py             # Async SMTP email alerts
│   ├── models.py                     # Pydantic data models
│   └── requirements.txt              # Python dependencies
│
├── data/                             # Persistent execution history (JSONL)
├── Dockerfile.backend                # Python backend container
├── Dockerfile.frontend               # Node build + Nginx container
├── docker-compose.yml                # Orchestration (backend + frontend)
├── nginx.conf                        # Reverse proxy + SSE + Basic Auth
├── .env.example                      # Template environment variables
└── .htpasswd                         # HTTP Basic Auth credentials (not in repo)
```

---

## 📡 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/events` | **SSE stream** — real-time ticker, arbitrage, and execution events |
| `GET` | `/api/status` | System status (WS connections, engine config, environment) |
| `POST` | `/api/credentials` | Set exchange API keys |
| `POST` | `/api/config` | Update engine parameters (filters, budgets, auto-execute) |
| `POST` | `/api/execute` | Manually trigger arbitrage execution |
| `POST` | `/api/exchange` | Switch active exchange (OKX ↔ Deribit) |
| `POST` | `/api/environment` | Switch environment (Real ↔ Testnet) |
| `GET` | `/api/balance` | Fetch account balance for active exchange |
| `GET` | `/api/executions` | Retrieve execution history |
| `GET` | `/health` | Health check |

---

## ⚙️ Configuration Parameters

| Parameter | Default | Description |
|---|---|---|
| `minVolume` | 10 | Minimum 24h volume filter |
| `maxSpreadPct` | 20 | Maximum bid-ask spread (%) filter |
| `includeFee` | true | Include 0.03% fee in LP model |
| `autoExecute` | false | Auto-execute on testnet when arb detected |
| `riskPct` | 25 | Percentage of account balance used as budget |

---

## 📄 License

This project is part of an academic Final Year Project (FYP). All rights reserved.
