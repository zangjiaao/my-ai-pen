import asyncio
import uuid

import bcrypt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import async_session
from app.models.user import User


async def seed():
    async with async_session() as db:
        result = await db.execute(select(User).where(User.email == "admin@pentest.local"))
        if result.scalar_one_or_none():
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
