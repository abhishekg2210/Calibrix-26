"""
logger.py
---------
Centralized logging configuration for the Autonomous Obstacle Detection project.
Provides both console and rotating file logging with colour support via the
`rich` library.

Usage:
    from src.utils.logger import get_logger
    logger = get_logger(__name__)
    logger.info("Training started")
"""

import logging
import os
import sys
from datetime import datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Optional

try:
    from rich.logging import RichHandler
    RICH_AVAILABLE = True
except ImportError:
    RICH_AVAILABLE = False


# ─── Constants ──────────────────────────────────────────────────────────────
LOG_DIR = Path("logs")
LOG_FORMAT = "%(asctime)s | %(levelname)-8s | %(name)s:%(lineno)d | %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"
MAX_BYTES = 10 * 1024 * 1024   # 10 MB per log file
BACKUP_COUNT = 5


def _ensure_log_dir(log_dir: Path) -> None:
    """Create the log directory if it does not exist."""
    log_dir.mkdir(parents=True, exist_ok=True)


def get_logger(
    name: str,
    level: str = "INFO",
    log_file: Optional[str] = None,
    log_dir: Optional[Path] = None,
    console: bool = True,
) -> logging.Logger:
    """
    Get or create a named logger with optional file output.

    Args:
        name:      Logger name (typically ``__name__`` of the calling module).
        level:     Log level string: DEBUG | INFO | WARNING | ERROR | CRITICAL.
        log_file:  Log file name.  Defaults to ``<name>_<date>.log``.
        log_dir:   Directory for log files.  Defaults to ``logs/``.
        console:   If True, attach a console (stdout) handler.

    Returns:
        Configured :class:`logging.Logger` instance.
    """
    logger = logging.getLogger(name)

    # Prevent duplicate handlers when the same logger is requested multiple times
    if logger.handlers:
        return logger

    numeric_level = getattr(logging, level.upper(), logging.INFO)
    logger.setLevel(numeric_level)

    # ── Console handler ──────────────────────────────────────────────────────
    if console:
        if RICH_AVAILABLE:
            console_handler = RichHandler(
                rich_tracebacks=True,
                show_path=True,
                markup=True,
            )
            console_handler.setFormatter(logging.Formatter("%(message)s", datefmt="[%X]"))
        else:
            console_handler = logging.StreamHandler(sys.stdout)
            console_handler.setFormatter(logging.Formatter(LOG_FORMAT, datefmt=DATE_FORMAT))

        console_handler.setLevel(numeric_level)
        logger.addHandler(console_handler)

    # ── File handler ─────────────────────────────────────────────────────────
    _log_dir = log_dir or LOG_DIR
    _ensure_log_dir(_log_dir)

    if log_file is None:
        date_str = datetime.now().strftime("%Y%m%d")
        log_file = f"{name.replace('.', '_')}_{date_str}.log"

    file_path = _log_dir / log_file
    file_handler = RotatingFileHandler(
        file_path,
        maxBytes=MAX_BYTES,
        backupCount=BACKUP_COUNT,
        encoding="utf-8",
    )
    file_handler.setFormatter(logging.Formatter(LOG_FORMAT, datefmt=DATE_FORMAT))
    file_handler.setLevel(numeric_level)
    logger.addHandler(file_handler)

    # Prevent log messages from propagating to the root logger
    logger.propagate = False

    return logger


def setup_project_logger(config: dict) -> logging.Logger:
    """
    Create the root project logger from a loaded configuration dict.

    Args:
        config: Dictionary loaded from ``training_config.yaml`` (``logging`` section).

    Returns:
        Configured project-level logger.
    """
    log_cfg = config.get("logging", {})
    return get_logger(
        name="obstacle_detection",
        level=log_cfg.get("level", "INFO"),
        log_file=log_cfg.get("log_file", "training.log"),
        log_dir=Path(log_cfg.get("log_dir", "logs")),
        console=log_cfg.get("console", True),
    )
