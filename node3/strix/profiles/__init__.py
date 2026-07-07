"""Target profile helpers for benchmark and intentionally vulnerable apps."""

from .loader import TargetProfile, infer_target_profile, load_target_profile

__all__ = ["TargetProfile", "infer_target_profile", "load_target_profile"]
