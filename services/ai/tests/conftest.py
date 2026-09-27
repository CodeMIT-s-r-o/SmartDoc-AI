import os

# Settings are read at first use; provide a complete test environment before app imports.
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@127.0.0.1:1/test")
os.environ.setdefault("INTERNAL_TOKEN", "test-internal-token-0123456789")
os.environ.setdefault("APP_VERSION", "test")
