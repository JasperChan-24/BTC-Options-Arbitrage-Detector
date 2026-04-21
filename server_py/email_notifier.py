"""
Email Notifier — sends email alerts when arbitrage opportunities are detected.

Uses aiosmtplib for async SMTP.  Configure via environment variables:
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, NOTIFY_EMAIL
"""

from __future__ import annotations
import os
import time
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Optional

import aiosmtplib

from .models import ArbitrageResult


@dataclass
class EmailConfig:
    host: str
    port: int
    user: str
    password: str
    to: str


class EmailNotifier:
    COOLDOWN = 300  # 5 minutes between emails (seconds)

    def __init__(self):
        self._config: Optional[EmailConfig] = None
        self._last_notify_time: float = 0
        self._load_from_env()

    # ─── Init ─────────────────────────────────────────────────────────────

    def _load_from_env(self) -> None:
        host = os.getenv("SMTP_HOST")
        port = int(os.getenv("SMTP_PORT", "587"))
        user = os.getenv("SMTP_USER")
        password = os.getenv("SMTP_PASS")
        to = os.getenv("NOTIFY_EMAIL")

        if not all([host, user, password, to]):
            print("[EMAIL] Email notifications disabled — missing SMTP config in .env")
            return

        self._config = EmailConfig(
            host=host,  # type: ignore
            port=port,
            user=user,  # type: ignore
            password=password,  # type: ignore
            to=to,  # type: ignore
        )
        print(f"[EMAIL] Email notifications enabled — sending to {to}")

    @property
    def is_enabled(self) -> bool:
        return self._config is not None

    # ─── Configure at runtime ─────────────────────────────────────────────

    def configure(self, config: EmailConfig) -> None:
        self._config = config
        print(f"[EMAIL] Email reconfigured — sending to {config.to}")

    # ─── Send helpers ─────────────────────────────────────────────────────

    async def _send(self, subject: str, body: str) -> bool:
        if self._config is None:
            return False
        msg = EmailMessage()
        msg["From"] = self._config.user
        msg["To"] = self._config.to
        msg["Subject"] = subject
        msg.set_content(body)

        try:
            await aiosmtplib.send(
                msg,
                hostname=self._config.host,
                port=self._config.port,
                username=self._config.user,
                password=self._config.password,
                use_tls=self._config.port == 465,
                start_tls=self._config.port != 465,
            )
            return True
        except Exception as e:
            print(f"[EMAIL] Failed to send: {e}")
            return False

    # ─── Public API ───────────────────────────────────────────────────────

    async def send_test_email(self) -> bool:
        if self._config is None:
            print("[EMAIL] Cannot send test email: not configured")
            return False
        ok = await self._send(
            "✉️ BTC Arbitrage: Email Test Successful",
            (
                "Hello!\n\n"
                "Your email notification system is set up correctly.\n"
                "You will receive alerts here when arbitrage opportunities are detected.\n\n"
                "— BTC Options Arbitrage Detector"
            ),
        )
        if ok:
            print(f"[EMAIL] Test email sent to {self._config.to}")
        return ok

    async def notify_arbitrage(self, result: ArbitrageResult, expiry: str) -> None:
        if self._config is None:
            return
        now = time.time()
        if now - self._last_notify_time < self.COOLDOWN:
            return
        self._last_notify_time = now

        portfolio_text = "\n".join(
            f"  {p.action.upper()} {p.amount:.2f}x {p.type} @ {p.strike} (${p.price:.2f})"
            for p in result.portfolio
        )

        subject = f"🚨 BTC Arbitrage: ${result.profit:.2f} profit detected"
        body = (
            f"Arbitrage opportunity detected!\n\n"
            f"Profit: ${result.profit:.2f}\n"
            f"Expiry: {expiry}\n"
            f"Legs: {len(result.portfolio)}\n\n"
            f"Portfolio:\n{portfolio_text}\n\n"
            f"Time: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n\n"
            f"— BTC Options Arbitrage Detector"
        )
        if await self._send(subject, body):
            print(f"[EMAIL] Arbitrage alert sent to {self._config.to}")

    async def notify_execution(
        self,
        profit: float,
        total_legs: int,
        success_legs: int,
        error: Optional[str] = None,
    ) -> None:
        if self._config is None:
            return

        if success_legs == total_legs:
            subject = f"✅ Arbitrage executed: ${profit:.2f} ({success_legs}/{total_legs} legs)"
        else:
            subject = f"⚠️ Partial execution: {success_legs}/{total_legs} legs"

        lines = [
            "Execution result:",
            f"  Expected Profit: ${profit:.2f}",
            f"  Legs: {success_legs}/{total_legs} filled",
        ]
        if error:
            lines.append(f"  Error: {error}")
        lines.append(f"\nTime: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")

        await self._send(subject, "\n".join(lines))
