"""RabbitMQ 消息队列 — 节点离线缓存 + 平台多实例广播"""
import json
import logging
from app.config import settings

logger = logging.getLogger(__name__)


class MessageQueue:
    """RabbitMQ 封装。MVP 使用内存队列作为 fallback，生产环境连接 RabbitMQ。"""

    def __init__(self):
        self._connection = None
        self._channel = None
        self._fallback_queues: dict[str, list] = {}

    async def connect(self):
        try:
            import aio_pika
            self._connection = await aio_pika.connect_robust(settings.RABBITMQ_URL)
            self._channel = await self._connection.channel()
            logger.info("RabbitMQ connected")
        except ImportError:
            logger.warning("aio_pika not installed, using in-memory fallback")
        except Exception as e:
            logger.warning(f"RabbitMQ unavailable, using in-memory fallback: {e}")

    async def publish(self, routing_key: str, message: dict):
        if self._channel:
            import aio_pika
            await self._channel.default_exchange.publish(
                aio_pika.Message(body=json.dumps(message).encode()), routing_key=routing_key)
        else:
            self._fallback_queues.setdefault(routing_key, []).append(message)

    async def consume(self, routing_key: str):
        if self._channel:
            import aio_pika
            queue = await self._channel.declare_queue(routing_key, durable=True)
            async for msg in queue:
                yield json.loads(msg.body.decode())
                await msg.ack()
        else:
            # Fallback: drain in-memory
            while routing_key in self._fallback_queues and self._fallback_queues[routing_key]:
                yield self._fallback_queues[routing_key].pop(0)

    async def close(self):
        if self._connection:
            await self._connection.close()


mq = MessageQueue()
