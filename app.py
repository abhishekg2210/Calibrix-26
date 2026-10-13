"""
Convenience entry point for RoadGuard AI Realtime Website.
Allows running 'python app.py' directly from the root workspace directory,
automatically invoking the project virtual environment if present.
"""
import os
import sys
import subprocess
import runpy

inner_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "RoadGuard_AI_Realtime_Website")
inner_app = os.path.join(inner_dir, "app.py")
venv_py = os.path.join(inner_dir, ".venv", "Scripts", "python.exe")

if __name__ == "__main__":
    if os.path.exists(venv_py) and os.path.abspath(sys.executable).lower() != os.path.abspath(venv_py).lower():
        os.chdir(inner_dir)
        sys.exit(subprocess.call([venv_py, "app.py"] + sys.argv[1:]))

    os.chdir(inner_dir)
    sys.path.insert(0, inner_dir)
    runpy.run_path(inner_app, run_name="__main__")
