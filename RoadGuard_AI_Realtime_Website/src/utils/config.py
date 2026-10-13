"""
config.py
---------
Configuration management using PyYAML with dot-notation access (OmegaConf).
Provides helpers for loading, merging, and validating YAML configs.

Usage:
    from src.utils.config import load_config
    cfg = load_config("configs/training_config.yaml")
    print(cfg.training.epochs)
"""

import os
from pathlib import Path
from typing import Any, Dict, Optional, Union

import yaml

try:
    from omegaconf import DictConfig, OmegaConf
    OMEGACONF_AVAILABLE = True
except ImportError:
    OMEGACONF_AVAILABLE = False


class ConfigDict(dict):
    """
    A dictionary subclass that supports attribute-style (dot-notation) access.

    Example:
        cfg = ConfigDict({"training": {"epochs": 100}})
        cfg.training.epochs   # → 100
    """

    def __getattr__(self, key: str) -> Any:
        try:
            value = self[key]
            if isinstance(value, dict):
                return ConfigDict(value)
            return value
        except KeyError:
            raise AttributeError(f"Config key '{key}' not found.")

    def __setattr__(self, key: str, value: Any) -> None:
        self[key] = value

    def __delattr__(self, key: str) -> None:
        try:
            del self[key]
        except KeyError:
            raise AttributeError(f"Config key '{key}' not found.")

    def get_nested(self, *keys: str, default: Any = None) -> Any:
        """
        Retrieve a nested value using a sequence of keys.

        Args:
            *keys:   Sequence of string keys forming the path.
            default: Value to return if path is missing.

        Returns:
            The value at the specified nested path, or *default*.
        """
        cfg = self
        for key in keys:
            if isinstance(cfg, (dict, ConfigDict)):
                cfg = cfg.get(key)
                if cfg is None:
                    return default
            else:
                return default
        return cfg


def load_config(
    config_path: Union[str, Path],
    overrides: Optional[Dict[str, Any]] = None,
) -> ConfigDict:
    """
    Load a YAML configuration file and return a :class:`ConfigDict`.

    Args:
        config_path: Path to the YAML file.
        overrides:   Optional flat dictionary of ``"section.key": value`` pairs
                     to override specific values after loading.

    Returns:
        :class:`ConfigDict` populated from the YAML file.

    Raises:
        FileNotFoundError: If the config file does not exist.
        yaml.YAMLError:    If the file cannot be parsed.
    """
    config_path = Path(config_path)
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with open(config_path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    cfg = ConfigDict(raw or {})

    # Apply overrides (dot-notation keys like "training.epochs")
    if overrides:
        for dotted_key, value in overrides.items():
            _set_nested(cfg, dotted_key.split("."), value)

    return cfg


def save_config(config: Union[ConfigDict, Dict], output_path: Union[str, Path]) -> None:
    """
    Serialise a config dictionary back to YAML.

    Args:
        config:      Config dictionary to serialise.
        output_path: Destination YAML file path.
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        yaml.dump(dict(config), f, default_flow_style=False, sort_keys=False)


def merge_configs(*configs: Dict) -> ConfigDict:
    """
    Merge multiple config dictionaries (right-most wins on conflicts).

    Args:
        *configs: Any number of dictionaries to merge.

    Returns:
        Merged :class:`ConfigDict`.
    """
    merged: Dict[str, Any] = {}
    for cfg in configs:
        _deep_merge(merged, dict(cfg))
    return ConfigDict(merged)


# ─── Private helpers ─────────────────────────────────────────────────────────

def _deep_merge(base: Dict, override: Dict) -> Dict:
    """Recursively merge *override* into *base* in place."""
    for key, value in override.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
    return base


def _set_nested(cfg: Dict, keys: list, value: Any) -> None:
    """Set a value in a nested dictionary using a list of keys."""
    for key in keys[:-1]:
        cfg = cfg.setdefault(key, {})
    cfg[keys[-1]] = value
