"""status_update / phase_changed are retired — never persist as chat."""
import asyncio

from app.ws.router import _save_message


def test_status_update_is_not_persisted():
    async def run():
        mid = await _save_message(
            {
                "type": "status_update",
                "conversation_id": "00000000-0000-0000-0000-000000000001",
                "message": "hard_graph stage_start graph=app_assessment stage=class_probe",
                "status": "running",
                "agent_phase": "hard_graph",
            },
            "agent",
        )
        assert mid is None

    asyncio.run(run())


def test_phase_changed_is_not_persisted():
    async def run():
        mid = await _save_message(
            {
                "type": "phase_changed",
                "conversation_id": "00000000-0000-0000-0000-000000000001",
                "phase": "class_probe",
            },
            "agent",
        )
        assert mid is None

    asyncio.run(run())
