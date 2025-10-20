from loguru import logger
import sys


def setup_logging() -> None:
    logger.remove()
    logger.add(sys.stderr, level="INFO", enqueue=True)
