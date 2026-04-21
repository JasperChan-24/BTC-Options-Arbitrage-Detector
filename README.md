# BTC Options Arbitrage Detector

**BTC Options Arbitrage Detector** is a full-stack, real-time decentralized finance (DeFi) and crypto options analysis tool. It continuously monitors the **OKX** and **Deribit** Bitcoin options markets via high-speed WebSockets, detects static arbitrage opportunities (such as Box Spreads, Butterfly Spreads, and Convexity violations) using a highly optimized Linear Programming (LP) model, and automatically executes trades across multiple environments.

## 🌟 Key Features

* **Multi-Exchange & Multi-Environment**: Concurrently monitors 4 distinct environments:
  * **Real Markets**: OKX Real & Deribit Real (Detection and logging only to prevent unintended real-world capital loss).
  * **Simulated/Testnet Markets**: OKX Paper Trading & Deribit Testnet (Detection, email notification, and automated trade execution).
* **High-Performance Python Backend**: A FastAPI server that maintains persistent async WebSockets with exchanges, runs the LP solver in background threads, and streams updates to the frontend via Server-Sent Events (SSE).
* **LP-Based Arbitrage Engine**: Utilizes linear programming algorithms to mathematically guarantee risk-free profit identification by analyzing the entire volatility surface across all expiries simultaneously.
* **Auto-Execution & Email Alerts**: On testnets, the engine can automatically structure and submit multi-leg combo orders via API, while sending detailed SMTP email notifications.
* **Interactive Demo/Stress Test Mode**: A UI sandbox that allows users to artificially inject pricing anomalies (e.g., applying a 30% premium or discount to specific order book quotes) to stress-test the detection algorithm in real-time.
* **Advanced Data Visualization & Tracking**: Features real-time convexity charts, payoff charts, dynamic options tables, and a persistent Execution Drawer to view the history of detected and executed portfolios.

## 🏗️ Architecture

The system is containerized via Docker and orchestrated with `docker-compose`.

1. **Backend (Python 3.11 + FastAPI)**
   * Manages API connections, API signing, data normalization, and the LP arbitrage engine (`scipy.optimize.linprog`).
   * Broadcasts high-frequency market updates and trade executions via SSE (`/api/events`).
   * Persists historical detections and executions to local `JSONL` files.
2. **Frontend (React 19 + TypeScript + Zustand)**
   * Connects to the backend SSE stream to render orderbooks and calculation results at 60fps without overwhelming the browser.
   * Handles user interactions, environment switching, settings modifications, and the isolated "Demo Mode".
3. **Nginx Reverse Proxy & Static File Server**
   * Serves the bundled React frontend and securely proxies frontend `/api` requests to the internal Python backend.
   * Protects the application using HTTP Basic Authentication (`.htpasswd`).

## 🧮 Mathematical Principles: The Arbitrage Engine

The core of this application resides in translating the theoretical **No-Arbitrage Condition** into a discrete Linear Programming (LP) problem.

A static arbitrage opportunity exists if and only if we can construct a portfolio with a **strictly positive initial cash flow** (premium collected) while guaranteeing a **non-negative payoff** at maturity across all possible underlying asset prices $S_T$.

### 1. The Objective Function

The goal is to maximize the initial profit at $t=0$ by buying at the Ask price and selling at the Bid price. Let $x_i$ and $y_i$ represent the amount of option $i$ bought and sold, respectively.
The objective function is defined as:

$$
\text{Maximize} \quad Z = \sum_{i} \left( y_i \cdot \text{Bid}_i - x_i \cdot \text{Ask}_i \right)
$$

### 2. Discretization of the State Space (Constraints)

To ensure $\text{Payoff}(S_T) \ge 0$ for all $S_T \in [0, \infty)$, the model exploits the piecewise linear convexity of European options. If a piecewise linear function is non-negative at $S_T = 0$, non-negative at all its kink points (strike prices $K$), and has a non-negative slope as $S_T \to \infty$, it is globally non-negative.

The LP model enforces this via three sets of constraints:
* **Left Boundary (Zero Underlying):** Ensures the portfolio payoff is non-negative if Bitcoin goes to zero ($S_T = 0$).
* **Kink Points (All Strike Prices):** Enforces that the net payoff at every strike node $k$ is non-negative: `payoff_${k}: { min: 0 }`.
* **Right Asymptotic Slope:** Ensures the payoff curve does not diverge negatively as $S_T \to \infty$.

If the solver finds a feasible solution with an objective value $Z > 0$, an arbitrage portfolio is mathematically confirmed.

## 🛠️ Tech Stack

* **Frontend:** React 19, TypeScript, Zustand (State Management), Tailwind CSS, Recharts (Data Visualization).
* **Backend:** Python 3.11, FastAPI, Uvicorn, asyncio, Scipy (LP Solver).
* **Infrastructure:** Docker, docker-compose, Nginx.

## 🚀 Environment Configuration

The application relies on a single `.env` file placed in the root directory. You must supply your exchange API keys and email credentials for the system to fully operate:

```env
# ── OKX API Credentials ──
OKX_API_KEY=your_api_key
OKX_SECRET_KEY=your_secret_key
OKX_PASSPHRASE=your_passphrase
OKX_SIMULATED=true

# ── Deribit API Credentials ──
DERIBIT_CLIENT_ID=your_client_id
DERIBIT_CLIENT_SECRET=your_client_secret
DERIBIT_TESTNET=true

# ── Server Config ──
SERVER_PORT=3001

# ── Email Notifications ──
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_USER=your_email@domain.com
SMTP_PASS=your_smtp_app_password
NOTIFY_EMAIL=recipient_email@domain.com
```

## 💻 Local Development Setup

To run the application locally without Docker:

1. **Start the Backend:**
   ```bash
   conda create -n btc-arb python=3.11
   conda activate btc-arb
   pip install -r server_py/requirements.txt
   python -m uvicorn server_py.main:app --host 0.0.0.0 --port 3001 --reload
   ```

2. **Start the Frontend:**
   ```bash
   npm install
   npm run dev
   ```

## ☁️ Cloud Deployment

The application is fully containerized for easy deployment to cloud VMs (e.g., Vultr, AWS, DigitalOcean).

1. Clone the repository on your server.
2. Place your populated `.env` file in the root directory.
3. Configure your desired username and password in `.htpasswd` (optional, protects the Web UI).
4. Build and start the containers:
   ```bash
   docker-compose up -d --build
   ```
5. Access the application at `http://<your-server-ip>`. Data will persist automatically in the isolated `./data` folder.