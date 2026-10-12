from functools import wraps
from flask import session, redirect, url_for, request, jsonify
from werkzeug.security import generate_password_hash, check_password_hash
from database import get_db

def hash_password(password: str) -> str:
    return generate_password_hash(password)

def verify_password(password: str, password_hash: str) -> bool:
    return check_password_hash(password_hash, password)

def create_user(username: str, email: str, password: str, full_name: str = '', role: str = 'operator'):
    if not username or not email or not password:
        return None, "Username, email, and password are required."
    
    if len(password) < 6:
        return None, "Password must be at least 6 characters long."

    hashed = hash_password(password)
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute('''
            INSERT INTO users (username, email, password_hash, full_name, role)
            VALUES (?, ?, ?, ?, ?)
        ''', (username.strip().lower(), email.strip().lower(), hashed, full_name.strip(), role))
        conn.commit()
        user_id = cursor.lastrowid
        conn.close()
        return get_user_by_id(user_id), None
    except Exception as e:
        conn.close()
        if 'UNIQUE constraint failed' in str(e):
            if 'users.username' in str(e):
                return None, "A user with this username already exists."
            return None, "A user with this email address already exists."
        return None, f"Database error: {str(e)}"

def authenticate_user(identifier: str, password: str):
    if not identifier or not password:
        return None, "Please provide both identifier and password."

    identifier_clean = identifier.strip().lower()
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT id, username, email, password_hash, full_name, role
        FROM users
        WHERE email = ? OR username = ? OR (username = 'admin' AND (? IN ('admin@roadguard.ai', 'admin@irie.ai', 'admin')))
    ''', (identifier_clean, identifier_clean, identifier_clean))
    user = cursor.fetchone()
    conn.close()

    if not user:
        return None, "Invalid email/username or password."

    if not verify_password(password, user['password_hash']):
        return None, "Invalid email/username or password."

    return {
        'id': user['id'],
        'username': user['username'],
        'email': user['email'],
        'full_name': user['full_name'],
        'role': user['role']
    }, None

def get_user_by_id(user_id: int):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT id, username, email, full_name, role, created_at FROM users WHERE id = ?', (user_id,))
    user = cursor.fetchone()
    conn.close()
    if user:
        return dict(user)
    return None

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not session.get('user_id'):
            if request.path.startswith('/api/'):
                return jsonify(ok=False, error="Authentication required. Please log in."), 401
            return redirect(url_for('login', next=request.url))
        return f(*args, **kwargs)
    return decorated_function
