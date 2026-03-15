"""
Audit Log — append-only local log of all outbound actions.

Every action the bot takes is logged with:
  - Timestamp
  - Which adapter initiated it
  - What action was taken
  - Destination URL
  - HTTP status code
  - Content hash (SHA-256 of request body — verifiable without storing content)

Audit files are daily, append-only, owner-readable only.
"""

import json
import stat
import hashlib
import logging
from pathlib import Path
from datetime import datetime, timezone

logger = logging.getLogger("peerzero-bot.audit")


class AuditLog:
    """Append-only audit log for all outbound bot actions."""

    def __init__(self, audit_dir: str):
        self._dir = Path(audit_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._dir.chmod(stat.S_IRWXU)

    def log(
        self,
        adapter: str,
        action: str,
        destination: str,
        status: int = 0,
        request_body: str | bytes | None = None,
        response_preview: str = "",
    ):
        """Append an audit entry. Never blocks, never raises."""
        try:
            entry = {
                "ts": datetime.now(timezone.utc).isoformat(),
                "adapter": adapter,
                "action": action,
                "destination": destination,
                "status": status,
            }

            if request_body:
                body_bytes = request_body if isinstance(request_body, bytes) else request_body.encode()
                entry["content_hash"] = f"sha256:{hashlib.sha256(body_bytes).hexdigest()}"

            if response_preview:
                entry["response_preview"] = response_preview[:200]

            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            log_file = self._dir / f"{today}.jsonl"

            with open(log_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, default=str) + "\n")

            # Ensure restricted permissions
            log_file.chmod(stat.S_IRUSR | stat.S_IWUSR)

        except Exception as e:
            # Audit logging NEVER blocks the bot
            logger.debug(f"Audit log write failed: {e}")
