import asyncio
import uuid

import bcrypt
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import async_session
from app.models.user import User
from app.models.node import Node, PLATFORM_AGENT_NODE_ID


async def seed():
    async with async_session() as db:
        # Retire leftover built-in platform agent node (product model: worker Nodes only).
        plat = await db.execute(
            select(Node).where(
                or_(Node.id == PLATFORM_AGENT_NODE_ID, Node.type == "platform")
            )
        )
        removed = 0
        for n in plat.scalars().all():
            await db.delete(n)
            removed += 1
        if removed:
            print(f"Retired {removed} platform agent node row(s)")

        result = await db.execute(select(User).where(User.email == "admin@pentest.local"))
        if result.scalar_one_or_none():
            await db.commit()
            print("Admin user already exists")
            return

        user = User(
            id=uuid.uuid4(),
            email="admin@pentest.local",
            password_hash=bcrypt.hashpw("admin123".encode(), bcrypt.gensalt()).decode(),
            display_name="Admin",
            role="admin",
        )
        db.add(user)
        await db.commit()
        print("Admin user created: admin@pentest.local / admin123")


if __name__ == "__main__":
    asyncio.run(seed())
