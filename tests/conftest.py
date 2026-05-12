"""Shared pytest configuration.

Adds scripts/ to sys.path so test modules can import from the same
namespace the production code uses (`from utils import ...`, etc.).
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
