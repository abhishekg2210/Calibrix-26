"""
Convenience entry point for RoadGuard AI Realtime Website.
Allows running 'python app.py' directly from the root workspace directory.
"""
import os
import sys
import runpy

inner_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "RoadGuard_AI_Realtime_Website")
inner_app = os.path.join(inner_dir, "app.py")

if __name__ == "__main__":
    os.chdir(inner_dir)
    sys.path.insert(0, inner_dir)
    runpy.run_path(inner_app, run_name="__main__")
