import os
import zipfile

def package_project():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    zip_filename = os.path.join(base_dir, "IRIE_Arduino_Route_Planner_Upgraded.zip")
    
    exclude_dirs = {'.venv', '__pycache__', '.git', '.idea', '.vscode'}
    exclude_extensions = {'.pyc', '.log'}

    print(f"Packaging project into: {zip_filename}")
    with zipfile.ZipFile(zip_filename, 'w', zipfile.ZIP_DEFLATED) as zip_file:
        for root, dirs, files in os.walk(base_dir):
            dirs[:] = [d for d in dirs if d not in exclude_dirs]
            for file in files:
                if any(file.endswith(ext) for ext in exclude_extensions):
                    continue
                if file.endswith('.zip') or file == 'irie.db':
                    continue
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, base_dir)
                zip_file.write(full_path, arcname=os.path.join("IRIE_Arduino_Route_Planner", rel_path))

    size_mb = os.path.getsize(zip_filename) / (1024 * 1024)
    print(f"Archive successfully created: {zip_filename} ({size_mb:.2f} MB)")

if __name__ == "__main__":
    package_project()
