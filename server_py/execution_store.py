"""
JSONL Execution Store — persists execution history to a JSONL file.

Each execution is appended as a single line of JSON.  On startup the file
is read line-by-line to reconstruct the in-memory history.
"""

from __future__ import annotations
import json
from pathlib import Path
from typing import Callable, List, Optional

from .models import ArbitrageExecution

DATA_DIR = Path.cwd() / "data"
EXEC_FILE = DATA_DIR / "executions.jsonl"


class ExecutionStore:
    def __init__(self):
        self._executions: List[ArbitrageExecution] = []
        self._ensure_data_dir()
        self._load_from_disk()

    # ─── Persistence ──────────────────────────────────────────────────────

    def _ensure_data_dir(self) -> None:
        if not DATA_DIR.exists():
            DATA_DIR.mkdir(parents=True)
            print(f"[STORE] Created data directory: {DATA_DIR}")

    def _load_from_disk(self) -> None:
        if not EXEC_FILE.exists():
            print("[STORE] No existing execution history — starting fresh")
            return
        try:
            content = EXEC_FILE.read_text(encoding="utf-8").strip()
            if not content:
                return
            for line in content.split("\n"):
                line = line.strip()
                if not line:
                    continue
                try:
                    exec_data = json.loads(line)
                    self._executions.append(ArbitrageExecution(**exec_data))
                except Exception:
                    print("[STORE] Skipping malformed line in JSONL file")
            print(f"[STORE] Loaded {len(self._executions)} executions from disk")
        except Exception as e:
            print(f"[STORE] Failed to load execution history: {e}")

    # ─── Public API ───────────────────────────────────────────────────────

    def add(self, execution: ArbitrageExecution) -> None:
        """Append a new execution to the store and persist to disk."""
        self._executions.append(execution)
        try:
            with open(EXEC_FILE, "a", encoding="utf-8") as f:
                f.write(execution.model_dump_json() + "\n")
        except Exception as e:
            print(f"[STORE] Failed to persist execution: {e}")

    def update(
        self,
        exec_id: str,
        updater: Callable[[ArbitrageExecution], ArbitrageExecution],
    ) -> None:
        """Update an existing execution. Rewrites the full file."""
        for i, ex in enumerate(self._executions):
            if ex.execId == exec_id:
                self._executions[i] = updater(ex)
                self._flush()
                return

    def delete(self, exec_id: str) -> bool:
        """Delete an execution by ID. Returns True if found and deleted."""
        before = len(self._executions)
        self._executions = [e for e in self._executions if e.execId != exec_id]
        if len(self._executions) < before:
            self._flush()
            return True
        return False

    def get_all(self) -> List[ArbitrageExecution]:
        """All executions, most recent first."""
        return list(reversed(self._executions))

    def get_recent(self, n: int = 50) -> List[ArbitrageExecution]:
        """Last N executions, most recent first."""
        return list(reversed(self._executions[-n:]))

    def get_paginated(
        self, offset: int = 0, limit: int = 30, date: Optional[str] = None, tz_offset: Optional[str] = None
    ) -> dict:
        """Paginated query with optional date filter (YYYY-MM-DD).
        Returns { items: [...], total: int, hasMore: bool }.
        """
        # All records, most recent first
        all_execs = list(reversed(self._executions))

        # Date filter
        if date:
            filtered = [
                e for e in all_execs
                if e.timestamp and self._local_date_str(e.timestamp, tz_offset) == date
            ]
        else:
            filtered = all_execs

        total = len(filtered)
        page = filtered[offset : offset + limit]
        return {
            "items": page,
            "total": total,
            "hasMore": offset + limit < total,
        }

    def get_available_dates(self, tz_offset: Optional[str] = None) -> List[str]:
        """Return all unique dates (YYYY-MM-DD) with records, newest first."""
        dates = set()
        for e in self._executions:
            if e.timestamp:
                d = self._local_date_str(e.timestamp, tz_offset)
                dates.add(d)
        return sorted(dates, reverse=True)

    def _local_date_str(self, utc_iso: str, tz_offset: Optional[str]) -> str:
        if not tz_offset:
            return utc_iso[:10]
        try:
            offset_mins = int(tz_offset)
            from datetime import datetime, timedelta
            iso = utc_iso.replace("Z", "+00:00")
            dt = datetime.fromisoformat(iso)
            # JS getTimezoneOffset is UTC - Local in minutes
            dt_local = dt - timedelta(minutes=offset_mins)
            return dt_local.strftime("%Y-%m-%d")
        except Exception:
            return utc_iso[:10]

    # ─── Internal ─────────────────────────────────────────────────────────

    def _flush(self) -> None:
        """Rewrite the entire file from in-memory state."""
        try:
            content = "\n".join(ex.model_dump_json() for ex in self._executions) + "\n"
            EXEC_FILE.write_text(content, encoding="utf-8")
        except Exception as e:
            print(f"[STORE] Failed to flush execution history: {e}")
