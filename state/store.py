"""
Redis-backed State Store.

Responsible for:
  - Saving / reading per-worker metrics snapshots
  - Storing controller decision log (ring buffer)
  - Providing cluster-wide aggregated view for the API / controller / router
"""

import json
import os
import time
import uuid
from typing import Any, Dict, List, Optional

import redis
from dotenv import load_dotenv

load_dotenv()

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT  = int(os.getenv("REDIS_PORT", "6379"))

# Redis key patterns
# IMPORTANT: These must match cpp/worker/redis_reporter.hpp exactly.
_METRICS_KEY    = "worker:{worker_id}:metrics"
_CTRL_LOG_KEY   = "btp:controller:log"
_CTRL_STATS_KEY = "btp:controller:stats"
_WORKERS_SET    = "btp:workers"            # set of known worker IDs
_QUERY_LOG_KEY  = "btp:router:queries"     # recent query routing decisions


class StateStore:
    """
    Thin wrapper around Redis for structured BTP state storage.
    All JSON-serialisable values are stored as strings.
    """

    def __init__(self):
        self.redis = redis.Redis(
            host=REDIS_HOST,
            port=REDIS_PORT,
            decode_responses=True,
        )
        self._check_connection()

    def _check_connection(self) -> None:
        try:
            self.redis.ping()
        except redis.ConnectionError:
            print(
                f"[StateStore] Notice: Redis not reachable at {REDIS_HOST}:{REDIS_PORT}. "
                "Operating in standby/mock mode until Redis connects."
            )

    # ------------------------------------------------------------------
    # Worker metrics
    # ------------------------------------------------------------------

    def save_worker_metrics(self, worker_id: str, metrics: dict) -> None:
        """
        Persist the latest metrics snapshot for a worker.
        Keeps a 60-item history of P99 latency for trending.
        TTL of 30 seconds ensures stale nodes are automatically removed.
        """
        key = _METRICS_KEY.format(worker_id=worker_id)
        self.redis.set(key, json.dumps(metrics), ex=30)
        # Register this worker in the global set
        self.redis.sadd(_WORKERS_SET, worker_id)
        # Append P99 latency to a ring-buffer list (for sparkline charts)
        history_key = f"worker:{worker_id}:latency_history"
        self.redis.rpush(history_key, metrics.get("p99_latency_ms", 0))
        self.redis.ltrim(history_key, -60, -1)  # keep last 60 values
        self.redis.expire(history_key, 120)

    def get_worker_metrics(self, worker_id: str) -> Optional[dict]:
        """Return the latest metrics for a worker, or None if stale/missing."""
        key = _METRICS_KEY.format(worker_id=worker_id)
        raw = self.redis.get(key)
        return json.loads(raw) if raw else None

    def get_latency_history(self, worker_id: str) -> list:
        """Return the last 60 P99 latency readings for a worker."""
        history_key = f"worker:{worker_id}:latency_history"
        vals = self.redis.lrange(history_key, 0, -1)
        return [float(v) for v in vals]

    def get_all_worker_ids(self) -> List[str]:
        """Return all known worker IDs (may include recently offline ones)."""
        try:
            return list(self.redis.smembers(_WORKERS_SET))
        except redis.ConnectionError:
            return []

    def get_cluster_metrics(self) -> Dict[str, dict]:
        """Return a dict mapping worker_id → latest metrics for all alive workers."""
        result = {}
        for wid in self.get_all_worker_ids():
            m = self.get_worker_metrics(wid)
            if m:  # only include if metrics TTL hasn't expired
                result[wid] = m
        return result

    # ------------------------------------------------------------------
    # Controller decision log
    # ------------------------------------------------------------------

    def log_controller_decision(self, worker_id: str, message: str) -> None:
        """Append a controller decision to the ring-buffer log (last 100 entries)."""
        try:
            entry = json.dumps({
                "ts": time.time(),
                "worker_id": worker_id,
                "message": message,
            })
            self.redis.rpush(_CTRL_LOG_KEY, entry)
            self.redis.ltrim(_CTRL_LOG_KEY, -100, -1)
            self.redis.expire(_CTRL_LOG_KEY, 3600)
        except redis.ConnectionError:
            pass

    def get_controller_log(self, n: int = 20) -> List[dict]:
        """Return the last n controller decisions."""
        try:
            entries = self.redis.lrange(_CTRL_LOG_KEY, -n, -1)
            return [json.loads(e) for e in entries]
        except redis.ConnectionError:
            return []

    # ------------------------------------------------------------------
    # Router query log
    # ------------------------------------------------------------------

    def log_query_routing(self, query_type: str, routed_to: str, score: float) -> None:
        """Log a router decision for dashboard display."""
        entry = json.dumps({
            "ts": time.time(),
            "query_type": query_type,
            "routed_to": routed_to,
            "score": round(score, 4),
        })
        self.redis.rpush(_QUERY_LOG_KEY, entry)
        self.redis.ltrim(_QUERY_LOG_KEY, -200, -1)
        self.redis.expire(_QUERY_LOG_KEY, 3600)

    def get_query_log(self, n: int = 50) -> List[dict]:
        """Return the last n routing decisions."""
        entries = self.redis.lrange(_QUERY_LOG_KEY, -n, -1)
        return [json.loads(e) for e in entries]

    # ------------------------------------------------------------------
    # Controller pub/sub & RPC (sends commands / point queries to workers)
    # ------------------------------------------------------------------

    def send_command(self, worker_id: str, command: dict) -> None:
        """Publish a command dict to the worker's command channel."""
        channel = f"ctrl:commands:{worker_id}"
        self.redis.publish(channel, json.dumps(command))

    def query_worker_frequency(
        self,
        worker_id: str,
        key: str,
        timeout_sec: float = 1.0,
    ) -> Optional[dict]:
        """
        Execute a live point-frequency RPC against a specific worker's CMS
        using Redis pub/sub request + ephemeral list reply.
        """
        reply_key = f"rpc:freq:{uuid.uuid4().hex}"
        self.send_command(worker_id, {
            "action": "query_frequency",
            "key": key,
            "reply_key": reply_key,
        })
        result = self.redis.blpop(reply_key, timeout=max(1, int(round(timeout_sec))))
        if not result:
            return None
        _, raw = result
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    def query_worker_registers(
        self,
        worker_id: str,
        timeout_sec: float = 1.0,
    ) -> Optional[dict]:
        """
        Execute an RPC to retrieve a worker's raw HyperLogLog registers
        for distributed Monoid maximum merge.
        """
        reply_key = f"rpc:hll:{uuid.uuid4().hex}"
        self.send_command(worker_id, {
            "action": "query_cardinality_registers",
            "reply_key": reply_key,
        })
        result = self.redis.blpop(reply_key, timeout=max(1, int(round(timeout_sec))))
        if not result:
            return None
        _, raw = result
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    def query_worker_heavy_hitters_partial(
        self,
        worker_id: str,
        timeout_sec: float = 1.0,
    ) -> Optional[dict]:
        """
        Execute an RPC to retrieve a worker's partial Misra-Gries candidate map
        for distributed Monoid merge.
        """
        reply_key = f"rpc:mg:{uuid.uuid4().hex}"
        self.send_command(worker_id, {
            "action": "query_heavy_hitters_partial",
            "reply_key": reply_key,
        })
        result = self.redis.blpop(reply_key, timeout=max(1, int(round(timeout_sec))))
        if not result:
            return None
        _, raw = result
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    # ------------------------------------------------------------------
    # Controller telemetry (ML / RL stats)
    # ------------------------------------------------------------------

    def save_controller_stats(self, stats: dict) -> None:
        """Persist live controller telemetry (mode, epsilon, rewards, Q-table summary)."""
        try:
            self.redis.set(_CTRL_STATS_KEY, json.dumps(stats), ex=300)
        except redis.ConnectionError:
            pass

    def get_controller_stats(self) -> Optional[dict]:
        """Return latest controller telemetry, or None if unavailable."""
        try:
            raw = self.redis.get(_CTRL_STATS_KEY)
            return json.loads(raw) if raw else None
        except redis.ConnectionError:
            return None
