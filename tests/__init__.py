"""Tests never read or write the real app-data folder for AI settings: an app made without `ai=` gets this scratch folder."""

import atexit
import os
import shutil
import tempfile

if "PERSONAL_NOTE_AI_DIR" not in os.environ:
    _folder = tempfile.mkdtemp(prefix="pn-test-ai-")
    os.environ["PERSONAL_NOTE_AI_DIR"] = _folder
    atexit.register(shutil.rmtree, _folder, ignore_errors=True)
