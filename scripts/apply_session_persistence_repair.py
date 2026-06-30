"""Apply the session persistence repair SQL without requiring Alembic CLI."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from sqlalchemy import text

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform" / "backend"))

from app.db.base import async_session  # noqa: E402


STATEMENTS = [
    'CREATE EXTENSION IF NOT EXISTS "pgcrypto"',
    "ALTER TABLE assets ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id)",
    "ALTER TABLE assets ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id)",
    "ALTER TABLE assets ADD COLUMN IF NOT EXISTS node_id uuid REFERENCES nodes(id)",
    "ALTER TABLE vulnerabilities ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id)",
    "ALTER TABLE vulnerabilities ADD COLUMN IF NOT EXISTS node_id uuid REFERENCES nodes(id)",
    """
    CREATE TABLE IF NOT EXISTS evidence (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        evidence_id varchar(100) NOT NULL UNIQUE,
        user_id uuid REFERENCES users(id),
        conversation_id uuid REFERENCES conversations(id),
        node_id uuid REFERENCES nodes(id),
        type varchar(50) NOT NULL,
        source_tool varchar(100),
        tool_run_id varchar(100),
        raw_ref varchar(500),
        summary varchar,
        hash varchar(128),
        properties jsonb DEFAULT '{}'::jsonb,
        created_at timestamptz DEFAULT now()
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_asset_user_address ON assets(user_id, address)",
    "CREATE INDEX IF NOT EXISTS idx_asset_conversation ON assets(conversation_id, updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_vuln_user_severity ON vulnerabilities(user_id, severity, status)",
    "CREATE INDEX IF NOT EXISTS idx_vuln_conversation ON vulnerabilities(conversation_id, discovered_at)",
    "CREATE INDEX IF NOT EXISTS idx_evidence_conversation ON evidence(conversation_id, created_at)",
    """
    UPDATE vulnerabilities v
    SET user_id = c.user_id, node_id = COALESCE(v.node_id, c.node_id)
    FROM conversations c
    WHERE v.conversation_id = c.id
      AND (v.user_id IS NULL OR v.node_id IS NULL)
    """,
    """
    UPDATE assets a
    SET user_id = COALESCE(a.user_id, c.user_id),
        node_id = COALESCE(a.node_id, c.node_id)
    FROM conversations c
    WHERE a.conversation_id = c.id
      AND (a.user_id IS NULL OR a.node_id IS NULL)
    """,
]


async def main() -> None:
    async with async_session() as db:
        for statement in STATEMENTS:
            await db.execute(text(statement))
        await db.commit()
    print("session persistence repair applied")


if __name__ == "__main__":
    asyncio.run(main())
