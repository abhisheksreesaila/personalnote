"""Shared intelligence wire protocol — mirrors intelligence/protocol/schemas.ts."""

PROTOCOL_VERSION = "1"

INTELLIGENCE_TIERS = frozenset({"local-only", "local-first", "cloud-ok"})
TASK_NAMES = frozenset({"rank-related", "scan-page"})

EXECUTOR_KINDS = frozenset({"deterministic", "local-model", "cloud-model"})
