import sqlite3
import os
from werkzeug.security import generate_password_hash

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'irie.db')

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    cursor = conn.cursor()

    # Users table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            full_name TEXT,
            role TEXT DEFAULT 'operator',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Telemetry logs table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS telemetry_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lat REAL,
            lng REAL,
            speed_kmh REAL,
            heading REAL,
            battery_voltage REAL,
            battery_pct REAL,
            vibration_g REAL,
            status TEXT,
            is_simulated INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Routes history
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS routes_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            start_lat REAL,
            start_lng REAL,
            end_lat REAL,
            end_lng REAL,
            primary_distance_km REAL,
            primary_duration_min REAL,
            alternatives_count INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Alerts and notifications
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            severity TEXT NOT NULL,
            alert_type TEXT NOT NULL,
            lat REAL,
            lng REAL,
            is_resolved INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Settings table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    ''')

    # Seed default demo administrator account
    demo_email = os.environ.get('DEMO_EMAIL', 'admin@roadguard.ai')
    demo_password = os.environ.get('DEMO_PASSWORD', 'Admin@123')
    demo_name = os.environ.get('DEMO_NAME', 'RoadGuard Mission Lead')

    cursor.execute('SELECT id FROM users WHERE email = ?', (demo_email,))
    existing_user = cursor.fetchone()
    if not existing_user:
        hashed = generate_password_hash(demo_password)
        try:
            cursor.execute('''
                INSERT INTO users (username, email, password_hash, full_name, role)
                VALUES (?, ?, ?, ?, ?)
            ''', ('admin', demo_email, hashed, demo_name, 'admin'))
        except sqlite3.IntegrityError:
            cursor.execute('''
                UPDATE users SET email = ?, full_name = ? WHERE username = 'admin'
            ''', (demo_email, demo_name))

    # Seed sample initial alert if empty
    cursor.execute('SELECT COUNT(*) as cnt FROM alerts')
    if cursor.fetchone()['cnt'] == 0:
        cursor.execute('''
            INSERT INTO alerts (title, message, severity, alert_type, lat, lng)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (
            'System Initialized',
            'IRIE Road Intelligence Engine telemetry and route monitoring online.',
            'INFO',
            'SYSTEM',
            11.0168,
            76.9558
        ))

    conn.commit()
    conn.close()

if __name__ == '__main__':
    init_db()
    print("IRIE database initialized successfully.")
