"""Contract smoke for DockerSandbox without requiring Docker daemon access."""
from __future__ import annotations

import asyncio
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "node"))


class FakeExecResult:
    exit_code = 0
    output = (b"stdout", b"stderr")


class FakeContainer:
    def __init__(self):
        self.id = "abcdef123456"
        self.status = "running"
        self.exec_commands: list[str] = []
        self.stopped = False
        self.removed = False

    def reload(self):
        return None

    def exec_run(self, command, demux=True):
        self.exec_commands.append(command)
        assert demux is True
        return FakeExecResult()

    def stop(self, timeout=5):
        self.stopped = True
        assert timeout == 5

    def remove(self, force=True):
        self.removed = True
        assert force is True


class FakeContainers:
    def __init__(self):
        self.run_calls: list[dict] = []
        self.container = FakeContainer()

    def list(self, all=True, filters=None):
        assert all is True
        assert filters == {"name": "pentest-alpha-co"}
        return []

    def run(self, image, **kwargs):
        self.run_calls.append({"image": image, **kwargs})
        return self.container


class FakeDockerClient:
    def __init__(self):
        self.containers = FakeContainers()


async def main() -> None:
    fake_client = FakeDockerClient()
    docker_module = types.ModuleType("docker")
    docker_module.from_env = lambda: fake_client
    sys.modules["docker"] = docker_module

    from pentest_node.sandbox.docker import DockerSandbox

    with tempfile.TemporaryDirectory() as tmp:
        sandbox = DockerSandbox(
            image="pentest-sandbox:test",
            workspace=Path(tmp),
            mem_limit="512m",
            cpu_quota=25000,
        )
        await sandbox.start("alpha-contract")
        call = fake_client.containers.run_calls[0]
        session_dir = Path(tmp) / "session-alpha-contract"

        assert call["image"] == "pentest-sandbox:test"
        assert call["name"] == "pentest-alpha-co"
        assert call["command"] == ["tail -f /dev/null"]
        assert call["detach"] is True
        assert call["mem_limit"] == "512m"
        assert call["cpu_quota"] == 25000
        assert call["network_mode"] == "bridge"
        assert call["cap_drop"] == ["ALL"]
        assert call["cap_add"] == ["NET_RAW"]
        assert call["working_dir"] == "/workspace"
        assert call["volumes"] == {str(session_dir.absolute()): {"bind": "/workspace", "mode": "rw"}}
        assert session_dir.exists()

        result = await sandbox.execute("curl https://example.com", timeout=10)
        assert result == {"stdout": "stdout", "stderr": "stderr", "exit_code": 0}
        assert fake_client.containers.container.exec_commands == ["/bin/bash -lc 'cd /workspace && curl https://example.com'"]

        await sandbox.destroy()
        assert fake_client.containers.container.stopped
        assert fake_client.containers.container.removed
        print("docker sandbox smoke ok")


if __name__ == "__main__":
    asyncio.run(main())