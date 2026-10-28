"""Render entry point: one public HTTPS port for API, WebSockets and callbacks."""
import os

os.environ.setdefault('GAZE_TRANSPORT', 'cloud-streaming')
os.environ.setdefault('CLOUD_WORKFLOW_ID', 'look-pong-cloud-gaze-streaming')
os.environ.setdefault('PUBLIC_APP_ORIGINS', 'https://josephofiowa.com,https://www.josephofiowa.com')
os.environ.setdefault('CLOUD_MAX_SESSIONS', '3')
os.environ.setdefault('CLOUD_SESSION_SECONDS', '900')
os.environ.setdefault('CLOUD_STARTS_PER_HOUR', '30')
os.environ.setdefault('CLOUD_CALLBACK_INLINE', '1')
os.environ.setdefault('CLOUD_CALLBACK_ORIGIN', os.getenv('RENDER_EXTERNAL_URL', ''))
os.environ['APP_ENV'] = 'production'

from web_app import app  # noqa: E402
