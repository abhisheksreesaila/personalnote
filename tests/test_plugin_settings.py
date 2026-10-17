"""Built-in plugins (F-090): the per-machine choice, the API, and the command line agreeing with it."""

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from starlette.testclient import TestClient

from personal_note_cli import main
from plugin_settings import PluginSettings
from routes import create_app

H = {"x-personal-note": "1"}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.settings = PluginSettings(self.dir / "plugins")
        self.client = TestClient(create_app(self.dir / "notes.db", plugins=self.settings))

    def tearDown(self):
        self.tmp.cleanup()


class SettingsFileTests(Base):
    def test_mind_maps_are_on_until_someone_switches_them_off(self):
        self.assertEqual(self.settings.view(), {"mindmap": True, "voice": True, "meaning": True, "jam": False})

    def test_the_choice_is_remembered_by_a_new_reader(self):
        self.settings.set_enabled("mindmap", False)
        self.assertEqual(PluginSettings(self.dir / "plugins").view(), {"mindmap": False, "voice": True, "meaning": True, "jam": False})
        self.settings.set_enabled("mindmap", True)
        self.assertEqual(PluginSettings(self.dir / "plugins").view(), {"mindmap": True, "voice": True, "meaning": True, "jam": False})

    def test_a_damaged_file_means_the_defaults(self):
        (self.dir / "plugins").mkdir()
        (self.dir / "plugins" / "plugins.json").write_text("{nope", "utf-8")
        self.assertEqual(self.settings.view(), {"mindmap": True, "voice": True, "meaning": True, "jam": False})

    def test_the_folder_can_come_from_the_environment(self):
        with mock.patch.dict(os.environ, {"PERSONAL_NOTE_PLUGINS_DIR": str(self.dir / "env")}):
            PluginSettings().set_enabled("mindmap", False)
        self.assertEqual(json.loads((self.dir / "env" / "plugins.json").read_text("utf-8")), {"mindmap": False, "voice": True, "meaning": True, "jam": False})


class ApiTests(Base):
    def test_the_page_reads_the_choice(self):
        self.assertEqual(self.client.get("/api/plugins").json(), {"plugins": {"mindmap": True, "voice": True, "meaning": True, "jam": False}})

    def test_switching_off_and_on_is_kept(self):
        response = self.client.post("/api/plugins/mindmap", json={"enabled": False}, headers=H)
        self.assertEqual((response.status_code, response.json()), (200, {"plugins": {"mindmap": False, "voice": True, "meaning": True, "jam": False}}))
        self.assertEqual(self.client.get("/api/plugins").json(), {"plugins": {"mindmap": False, "voice": True, "meaning": True, "jam": False}})
        self.client.post("/api/plugins/mindmap", json={"enabled": True}, headers=H)
        self.assertEqual(self.client.get("/api/plugins").json(), {"plugins": {"mindmap": True, "voice": True, "meaning": True, "jam": False}})

    def test_another_web_page_cannot_switch_a_plugin(self):
        response = self.client.post("/api/plugins/mindmap", json={"enabled": False})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.settings.view(), {"mindmap": True, "voice": True, "meaning": True, "jam": False})

    def test_an_unknown_plugin_or_a_non_boolean_is_refused(self):
        self.assertEqual(self.client.post("/api/plugins/nope", json={"enabled": True}, headers=H).status_code, 400)
        self.assertEqual(self.client.post("/api/plugins/mindmap", json={"enabled": "no"}, headers=H).status_code, 400)

    def test_no_new_mind_map_while_off_but_the_old_ones_stay_readable(self):
        made = self.client.post("/api/notes", json={"title": "Old map", "noteType": "mindmap"}).json()
        self.client.post("/api/plugins/mindmap", json={"enabled": False}, headers=H)
        refused = self.client.post("/api/notes", json={"title": "New map", "noteType": "mindmap"})
        self.assertEqual(refused.status_code, 409)
        self.assertEqual(refused.json(), {"error": "Mind maps is switched off. Turn it on in Settings → Plugins."})
        self.assertEqual(self.client.post("/api/notes", json={"title": "Plain"}).status_code, 201)
        opened = self.client.get(f"/api/notes/{made['id']}").json()
        self.assertEqual((opened["noteType"], opened["title"], opened["content"]["nodes"][0]["text"]), ("mindmap", "Old map", "Central idea"))

    def test_backup_still_holds_mind_maps_while_off(self):
        self.client.post("/api/notes", json={"title": "Kept map", "noteType": "mindmap"})
        self.client.post("/api/plugins/mindmap", json={"enabled": False}, headers=H)
        response = self.client.get("/api/export/workspace")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([note["title"] for note in response.json()["notes"] if note["noteType"] == "mindmap"], ["Kept map"])


    def test_a_backup_with_mind_maps_imports_while_off_and_the_maps_open(self):
        self.client.post("/api/notes", json={"title": "Carried map", "noteType": "mindmap"})
        backup = self.client.get("/api/export/workspace").json()
        self.client.post("/api/plugins/mindmap", json={"enabled": False}, headers=H)
        other = TestClient(create_app(self.dir / "other.db", plugins=self.settings))
        self.assertEqual(other.post("/api/import/workspace", json=backup).status_code, 201)
        maps = [note for note in other.get("/api/notes").json() if note["noteType"] == "mindmap"]
        self.assertEqual([note["title"] for note in maps], ["Carried map"])
        self.assertEqual(other.get(f"/api/notes/{maps[0]['id']}").json()["content"]["nodes"][0]["text"], "Central idea")

    def test_capabilities_say_whether_mind_maps_are_on(self):
        self.assertTrue(self.client.get("/api/settings/capabilities").json()["modules"]["mindmap"]["available"])
        self.client.post("/api/plugins/mindmap", json={"enabled": False}, headers=H)
        self.assertFalse(self.client.get("/api/settings/capabilities").json()["modules"]["mindmap"]["available"])


class CliTests(Base):
    def run_cli(self, *arguments):
        output = io.StringIO()
        with mock.patch.dict(os.environ, {"PERSONAL_NOTE_PLUGINS_DIR": str(self.dir / "plugins")}), contextlib.redirect_stdout(output):
            code = main(["--database", str(self.dir / "cli.db"), *arguments])
        return code, json.loads(output.getvalue())

    def test_creating_a_mind_map_while_off_is_a_plain_error(self):
        self.settings.set_enabled("mindmap", False)
        code, result = self.run_cli("notes", "create", "--title", "Map", "--type", "mindmap")
        self.assertEqual(code, 2)
        self.assertEqual(result, {"ok": False, "error": "Mind maps is switched off. Turn it on in Settings → Plugins."})

    def test_a_canvas_note_and_reading_a_mind_map_still_work_while_off(self):
        code, made = self.run_cli("notes", "create", "--title", "Map", "--type", "mindmap")
        self.assertEqual(code, 0)
        self.settings.set_enabled("mindmap", False)
        self.assertEqual(self.run_cli("notes", "create", "--title", "Plain")[0], 0)
        output = io.StringIO()
        with mock.patch.dict(os.environ, {"PERSONAL_NOTE_PLUGINS_DIR": str(self.dir / "plugins")}), contextlib.redirect_stdout(output):
            code = main(["--database", str(self.dir / "cli.db"), "notes", "read", str(made["id"]), "--text"])
        self.assertEqual(code, 0)
        self.assertIn("Central idea", output.getvalue())

    def test_creating_a_mind_map_works_when_on(self):
        self.assertEqual(self.run_cli("notes", "create", "--title", "Map", "--type", "mindmap")[0], 0)


if __name__ == "__main__":
    unittest.main()
