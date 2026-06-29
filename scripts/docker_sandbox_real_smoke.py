"""Real Docker smoke for DockerSandbox.

Requires a running Docker daemon and a local pentest-sandbox image. Unlike
scripts/docker_sandbox_smoke.py, this starts an actual container and executes a
command inside it.
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))

from pentest_node.sandbox.docker import DockerSandbox  # noqa: E402


async def main() -> None:
    image = os.getenv("SANDBOX_IMAGE", "pentest-sandbox:latest")
    work_root = ROOT / ".alpha"
    work_root.mkdir(exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="docker-real-", dir=work_root) as tmp:
        sandbox = DockerSandbox(
            image=image,
            workspace=Path(tmp),
            mem_limit="512m",
            cpu_quota=25000,
        )
        await sandbox.start("alpha-real")
        try:
            result = await sandbox.execute("printf alpha-real && pwd && test -d /workspace", timeout=15)
            assert result["exit_code"] == 0, result
            assert "alpha-real" in result["stdout"], result
            assert "/workspace" in result["stdout"], result
        finally:
            await sandbox.destroy()

    print("real docker sandbox ok")


if __name__ == "__main__":
    asyncio.run(main())