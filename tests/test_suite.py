"""
Root test discovery forwarder for RoadGuard AI.
Enables running 'python -m unittest discover tests' directly from the root workspace directory.
"""
import os
import sys
import unittest

def load_tests(loader, standard_tests, pattern):
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    inner_dir = os.path.join(root_dir, "RoadGuard_AI_Realtime_Website")
    tests_dir = os.path.join(inner_dir, "tests")

    if inner_dir not in sys.path:
        sys.path.insert(0, inner_dir)
    os.chdir(inner_dir)

    return loader.discover(tests_dir, pattern="test*.py", top_level_dir=inner_dir)
