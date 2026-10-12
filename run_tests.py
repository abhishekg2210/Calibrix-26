"""
RoadGuard AI - Root Test Runner
Executes the full automated test suite for RoadGuard AI from the workspace root.
Usage:
    python run_tests.py
    python -m unittest discover tests
"""
import os
import sys
import unittest

def main():
    root_dir = os.path.dirname(os.path.abspath(__file__))
    inner_dir = os.path.join(root_dir, "RoadGuard_AI_Realtime_Website")
    tests_dir = os.path.join(inner_dir, "tests")

    if inner_dir not in sys.path:
        sys.path.insert(0, inner_dir)
    os.chdir(inner_dir)

    print(f"[*] Discovering RoadGuard AI tests in: {tests_dir}")
    loader = unittest.defaultTestLoader
    suite = loader.discover(tests_dir, pattern="test*.py", top_level_dir=inner_dir)
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    sys.exit(0 if result.wasSuccessful() else 1)

if __name__ == "__main__":
    main()
