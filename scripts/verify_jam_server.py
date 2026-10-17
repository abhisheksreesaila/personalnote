"""The real app with a scripted jam brain, for scripts/verify-jam.mjs (never for real use).

Everything comes from the environment: PERSONAL_NOTE_DB, PERSONAL_NOTE_PLUGINS_DIR, PN_JAM_PORT, PN_JAM_SCRIPT (a JSON file).
Each jam turn reads the script fresh and takes its first entry (the last one repeats):
  {"answer": {"edits": [...]}, "delay": 0.5}   the brain answers with this after `delay` seconds
  {"error": "text"}                            the brain could not be reached (the page shows the text, with Try again)
  {"setup": "text"}                            no brain is set up (the page points at Settings → AI)
The prompts the brain was given are appended to PN_JAM_SCRIPT + ".prompts" (one JSON line each), so the check can see what was sent.
"""

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import uvicorn  # noqa: E402

from jam_brain import BrainNotSetUp, BrainUnavailable  # noqa: E402
from plugin_settings import PluginSettings  # noqa: E402
from routes import create_app  # noqa: E402

script = Path(os.environ["PN_JAM_SCRIPT"])


class ScriptedBrain:
    def complete(self, system, user):
        with open(f"{script}.prompts", "a", encoding="utf-8") as log:
            log.write(json.dumps(user) + "\n")
        entries = json.loads(script.read_text("utf-8"))
        entry = entries[0]
        if len(entries) > 1:
            script.write_text(json.dumps(entries[1:]), "utf-8")
        time.sleep(entry.get("delay", 0))
        if "setup" in entry:
            raise BrainNotSetUp(entry["setup"])
        if "error" in entry:
            raise BrainUnavailable(entry["error"])
        return json.dumps(entry["answer"])


# Every path is named here, so a check can never touch the captain's notes, plugin choices or AI settings.
app = create_app(os.environ["PERSONAL_NOTE_DB"], plugins=PluginSettings(os.environ["PERSONAL_NOTE_PLUGINS_DIR"]), brain=lambda: ScriptedBrain())
uvicorn.run(app, host="127.0.0.1", port=int(os.environ["PN_JAM_PORT"]), log_level="warning")
