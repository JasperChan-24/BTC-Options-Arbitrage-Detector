"""
Tests for execution_store.py — JSONL persistence layer.

NOTE: ExecutionStore uses a hardcoded DATA_DIR / EXEC_FILE path,
so we patch those module-level constants for testing.
"""

import pytest
import os
import json
from pathlib import Path
from unittest.mock import patch

from server_py.models import ArbitrageExecution, SubmittedOrder


def _make_execution(exec_id: str, timestamp: str = "2025-01-01T00:00:00Z",
                    profit: float = 42.5, status: str = "pending") -> ArbitrageExecution:
    """Helper to create ArbitrageExecution instances."""
    return ArbitrageExecution(
        execId=exec_id,
        timestamp=timestamp,
        expectedProfit=profit,
        orders=[],
        overallStatus=status,
    )


@pytest.fixture
def patched_store(tmp_data_dir):
    """Create an ExecutionStore with patched file paths."""
    data_dir = Path(tmp_data_dir)
    exec_file = data_dir / "test_executions.jsonl"

    with patch("server_py.execution_store.DATA_DIR", data_dir), \
         patch("server_py.execution_store.EXEC_FILE", exec_file):
        from server_py.execution_store import ExecutionStore
        store = ExecutionStore()
        yield store


class TestExecutionStore:
    """JSONL persistence tests."""

    def test_add_and_get_all(self, patched_store):
        """Add a record and retrieve it."""
        store = patched_store
        exec_data = _make_execution("exec-001")
        store.add(exec_data)

        all_records = store.get_all()
        assert len(all_records) == 1
        assert all_records[0].execId == "exec-001"
        assert all_records[0].expectedProfit == 42.5

    def test_add_multiple(self, patched_store):
        """Add multiple records, verify count."""
        store = patched_store
        for i in range(5):
            store.add(_make_execution(f"exec-{i:03d}", profit=i * 10.0))

        all_records = store.get_all()
        assert len(all_records) == 5

    def test_delete(self, patched_store):
        """Delete a record and verify it's gone."""
        store = patched_store
        store.add(_make_execution("keep"))
        store.add(_make_execution("remove"))

        assert len(store.get_all()) == 2
        deleted = store.delete("remove")
        assert deleted is True
        all_records = store.get_all()
        assert len(all_records) == 1
        assert all_records[0].execId == "keep"

    def test_delete_nonexistent(self, patched_store):
        """Deleting a non-existent record should return False."""
        store = patched_store
        store.add(_make_execution("exists"))
        deleted = store.delete("does-not-exist")
        assert deleted is False
        assert len(store.get_all()) == 1

    def test_get_paginated(self, patched_store):
        """Test pagination with offset and limit."""
        store = patched_store
        for i in range(10):
            store.add(_make_execution(
                f"exec-{i:03d}",
                timestamp=f"2025-01-{i+1:02d}T00:00:00Z",
            ))

        page1 = store.get_paginated(offset=0, limit=3)
        assert len(page1["items"]) == 3
        assert page1["total"] == 10
        assert page1["hasMore"] is True

        page_last = store.get_paginated(offset=9, limit=3)
        assert len(page_last["items"]) == 1
        assert page_last["hasMore"] is False

    def test_get_recent(self, patched_store):
        """get_recent should return most recent N items."""
        store = patched_store
        for i in range(10):
            store.add(_make_execution(f"exec-{i:03d}"))

        recent = store.get_recent(n=3)
        assert len(recent) == 3
        # Most recent first
        assert recent[0].execId == "exec-009"

    def test_persistence_across_instances(self, tmp_data_dir):
        """Data should survive store re-instantiation."""
        data_dir = Path(tmp_data_dir)
        exec_file = data_dir / "persist_test.jsonl"

        with patch("server_py.execution_store.DATA_DIR", data_dir), \
             patch("server_py.execution_store.EXEC_FILE", exec_file):
            from server_py.execution_store import ExecutionStore

            store1 = ExecutionStore()
            store1.add(_make_execution("survive", profit=99.0))

            store2 = ExecutionStore()
            all_records = store2.get_all()
            assert len(all_records) == 1
            assert all_records[0].execId == "survive"

    def test_empty_file(self, tmp_data_dir):
        """Empty file should load without error."""
        data_dir = Path(tmp_data_dir)
        exec_file = data_dir / "empty.jsonl"
        exec_file.touch()

        with patch("server_py.execution_store.DATA_DIR", data_dir), \
             patch("server_py.execution_store.EXEC_FILE", exec_file):
            from server_py.execution_store import ExecutionStore
            store = ExecutionStore()
            assert store.get_all() == []

    def test_corrupted_line_skipped(self, tmp_data_dir):
        """Corrupted JSON lines should be skipped gracefully."""
        data_dir = Path(tmp_data_dir)
        exec_file = data_dir / "corrupted.jsonl"

        # Write a mix of valid and invalid lines
        good1 = _make_execution("good-1")
        good2 = _make_execution("good-2")
        with open(exec_file, 'w') as f:
            f.write(good1.model_dump_json() + '\n')
            f.write('THIS IS NOT JSON\n')
            f.write(good2.model_dump_json() + '\n')

        with patch("server_py.execution_store.DATA_DIR", data_dir), \
             patch("server_py.execution_store.EXEC_FILE", exec_file):
            from server_py.execution_store import ExecutionStore
            store = ExecutionStore()
            all_records = store.get_all()
            assert len(all_records) == 2

    def test_available_dates(self, patched_store):
        """get_available_dates should return unique dates."""
        store = patched_store
        store.add(_make_execution("a", timestamp="2025-01-01T10:00:00Z"))
        store.add(_make_execution("b", timestamp="2025-01-01T14:00:00Z"))
        store.add(_make_execution("c", timestamp="2025-01-02T08:00:00Z"))

        dates = store.get_available_dates()
        assert len(dates) == 2
        assert "2025-01-02" in dates
        assert "2025-01-01" in dates
