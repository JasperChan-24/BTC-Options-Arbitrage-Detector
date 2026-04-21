"""
SSE (Server-Sent Events) Manager

Manages connected frontend clients and broadcasts events.
Uses asyncio.Queue per client for non-blocking push.
"""

from __future__ import annotations
import asyncio
import json
import time
from typing import Any, AsyncGenerator, Tuple


class SseManager:
    # Bounded queue size — prevents memory blowup when frontend is slow
    MAX_QUEUE_SIZE = 50

    def __init__(self):
        self._clients: dict[str, asyncio.Queue] = {}
        self._counter = 0

    # ─── Client management ────────────────────────────────────────────────

    def add_client(self) -> Tuple[str, AsyncGenerator]:
        """Register a new SSE client, returns (client_id, event_generator)."""
        self._counter += 1
        client_id = f"sse-{self._counter}"
        queue: asyncio.Queue = asyncio.Queue(maxsize=self.MAX_QUEUE_SIZE)
        self._clients[client_id] = queue
        print(f"[SSE] Client connected: {client_id} (total: {len(self._clients)})")

        # Push connected event
        queue.put_nowait({
            "event": "connected",
            "data": json.dumps({"clientId": client_id}),
        })

        # Return the async generator directly (not a coroutine!)
        return client_id, self._event_stream(client_id, queue)

    def remove_client(self, client_id: str) -> None:
        self._clients.pop(client_id, None)
        print(f"[SSE] Client disconnected: {client_id} (total: {len(self._clients)})")

    async def _event_stream(
        self, client_id: str, queue: asyncio.Queue
    ) -> AsyncGenerator[dict, None]:
        """
        Async generator that yields SSE events from the client's queue.
        Each yielded dict has 'event' and 'data' keys which sse-starlette
        will format as standard SSE text.
        """
        try:
            while True:
                msg = await queue.get()
                yield msg
        except asyncio.CancelledError:
            pass
        finally:
            self.remove_client(client_id)

    # ─── Broadcasting ─────────────────────────────────────────────────────

    def broadcast(self, event: str, data: Any) -> None:
        """Broadcast an event to all connected clients."""
        payload = {"event": event, "data": json.dumps(data, default=str)}
        dead: list[str] = []
        for cid, queue in self._clients.items():
            try:
                # If queue is full, drop oldest message to make room
                if queue.full():
                    try:
                        queue.get_nowait()
                    except Exception:
                        pass
                queue.put_nowait(payload)
            except Exception:
                dead.append(cid)
        for cid in dead:
            self._clients.pop(cid, None)

    def send_to(self, client_id: str, event: str, data: Any) -> None:
        """Send an event to a specific client."""
        queue = self._clients.get(client_id)
        if queue is None:
            return
        try:
            queue.put_nowait({
                "event": event,
                "data": json.dumps(data, default=str),
            })
        except Exception:
            self._clients.pop(client_id, None)

    @property
    def client_count(self) -> int:
        return len(self._clients)
