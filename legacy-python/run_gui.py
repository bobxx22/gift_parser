"""Запуск GUI: python run_gui.py"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from gift_parser.gui import main  # noqa: E402

if __name__ == "__main__":
    main()
