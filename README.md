# BTC Options Arbitrage Detector

**BTC Options Arbitrage Detector** is a real-time decentralized finance (DeFi) and crypto options analysis tool. It continuously monitors the Deribit Bitcoin options market, fetching live order book data to detect static arbitrage opportunities (such as Box Spreads, Butterfly Spreads, and Convexity violations) using a highly optimized Linear Programming (LP) model.

## 🌟 Key Features

* **Real-time Data Integration**: Fetches live BTC options chain data (bid, ask, volume, underlying price) directly from the Deribit REST API.

* **LP-Based Arbitrage Engine**: Utilizes `javascript-lp-solver` to mathematically guarantee risk-free profit identification by analyzing the entire volatility surface.

* **Dynamic Market Filtering**: Customizable filters for minimum 24h trading volume and maximum Bid-Ask spread percentage to ensure detected opportunities are executable in real-world liquidity conditions.

* **Interactive Demo/Stress Test Mode**: Allows users to artificially inject pricing anomalies (e.g., applying a 30% premium or discount to specific order book quotes) to stress-test the detection algorithm.

* **Advanced Data Visualization**: Features real-time convexity charts (visualizing call/put bid-ask curves) and payoff charts for the detected optimal arbitrage portfolio using Recharts.

## 🧮 Mathematical Principles: The Arbitrage Engine

The core of this application resides in the `arbitrageService.ts` module. It translates the theoretical **No-Arbitrage Condition** into a discrete Linear Programming (LP) problem.

A static arbitrage opportunity exists if and only if we can construct a portfolio with a **strictly positive initial cash flow** (premium collected) while guaranteeing a **non-negative payoff** at maturity across all possible underlying asset prices $S_T$.

### 1. The Objective Function

The goal is to maximize the initial profit at $t=0$ by buying at the Ask price and selling at the Bid price. Let $x_i$ and $y_i$ represent the amount of option $i$ bought and sold, respectively.
The objective function is defined as:

$$
\text{Maximize} \quad Z = \sum_{i} \left( y_i \cdot \text{Bid}_i - x_i \cdot \text{Ask}_i \right)
$$

In the model, this is implemented by assigning `-opt.ask` as the profit for `buy_i` variables and `opt.bid` as the profit for `sell_i` variables. To prevent infinite positions, a normalized position limit is applied: $0 \le x_i, y_i \le 1$.

### 2. Discretization of the State Space (Constraints)

To ensure $\text{Payoff}(S_T) \ge 0$ for all $S_T \in [0, \infty)$, the model exploits the piecewise linear convexity of European options. If a piecewise linear function is non-negative at $S_T = 0$, non-negative at all its kink points (strike prices $K$), and has a non-negative slope as $S_T \to \infty$, it is globally non-negative.

The LP model enforces this via three sets of constraints:

* **Left Boundary (Zero Underlying):**
  Ensures the portfolio payoff is non-negative if Bitcoin goes to zero ($S_T = 0$).
  Implemented as `payoff_0: { min: 0 }`. Calls contribute 0, while Puts contribute their strike price $K$.

* **Kink Points (All Strike Prices):**
  The model extracts a set of all unique strike prices across the options chain. It enforces that the net payoff at every strike node $k$ is non-negative: `payoff_${k}: { min: 0 }`.
  The payoff contribution for an option $i$ at node $k$ is calculated as $\max(k - K_i, 0)$ for Calls and $\max(K_i - k, 0)$ for Puts.

* **Right Asymptotic Slope:**
  Ensures the payoff curve does not diverge negatively as $S_T \to \infty$.
  Implemented as `right_slope: { min: 0 }`. Since Puts have a 0 slope and Calls have a slope of 1 as $S_T \to \infty$, buying a Call adds $+1$ to the slope, and selling a Call adds $-1$.

If the solver finds a feasible solution with an objective value $Z > 0$, an arbitrage portfolio is mathematically confirmed.

## 🛠️ Tech Stack

* **Frontend Framework:** React 19, TypeScript, Vite

* **Styling:** Tailwind CSS, Lucide React (Icons)

* **Data Visualization:** Recharts (SVG-based charting)

* **Mathematical Engine:** `javascript-lp-solver`

* **Internationalization:** Built-in i18n support (English/Chinese)

## 🚀 Local Development Setup

**Prerequisites:** Node.js (v18+ recommended)

1. **Clone the repository and install dependencies:**

   ```bash
   npm install
2. **Start the development server:**
   
   ```bash
   npm run dev
3. **Access the application:**
Open your browser and navigate to the local URL provided in your terminal (usually http://localhost:3000/ or http://localhost:5173/).

## 📂 Project Structure

```text
.
├── src/
│   ├── components/
│   │   └── Dashboard.tsx      # Main UI, filters, Recharts integration, and Demo mode logic
│   ├── services/
│   │   ├── arbitrageService.ts # Core Linear Programming model and No-Arbitrage logic
│   │   └── deribitService.ts   # Live data fetching from Deribit REST API
│   ├── App.tsx                # Application shell and language toggle
│   ├── i18n.ts                # Localization dictionary
│   ├── index.css              # Global Tailwind CSS styles
│   ├── types.ts               # Strict TypeScript interfaces for Options and Portfolios
│   └── main.tsx               # React entry point
├── package.json               # Project dependencies and npm scripts
├── tsconfig.json              # TypeScript compiler configuration
└── vite.config.ts             # Vite bundler configuration