"""A note's emoji icon (F-100): chosen (emoji + tint 1-5), else guessed from the title, else the type's default."""
import contextlib
import io
import json
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path

from starlette.testclient import TestClient

from note_icon import guess_emoji, tint_of
from personal_note_cli import main
from routes import create_app


class GuessTests(unittest.TestCase):
    def test_a_title_suggests_an_emoji_from_its_words(self):
        self.assertEqual(guess_emoji("Lisbon trip"), "✈️")
        self.assertEqual(guess_emoji("Grocery list"), "🛒")
        self.assertEqual(guess_emoji("Startup pitch"), "🚀")
        self.assertEqual(guess_emoji("Weekly review"), "🗓️")

    def test_a_title_that_starts_with_an_emoji_uses_it(self):
        self.assertEqual(guess_emoji("🍋 Lemon cake"), "🍋")

    def test_no_known_word_means_no_guess(self):
        self.assertEqual(guess_emoji("Zzz qqq"), "")
        self.assertEqual(guess_emoji(""), "")

    def test_a_tint_is_one_to_five_and_stays_the_same_for_an_emoji(self):
        tints = {tint_of(emoji) for emoji in "🍋✈🚀📚💡🧠🎨📄🛒🌱"}
        self.assertTrue(tints <= {1, 2, 3, 4, 5})
        self.assertGreater(len(tints), 1)
        self.assertEqual(tint_of("🍋"), tint_of("🍋"))


class NoteIconApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temporary_directory.name) / "personal-note.db"
        self.client = TestClient(create_app(self.database_path))

    def tearDown(self):
        self.client.close()
        self.temporary_directory.cleanup()

    def make(self, title, note_type="page"):
        return self.client.post("/api/notes", json={"title": title, "noteType": note_type}).json()

    def listed(self, note_id):
        return next(item for item in self.client.get("/api/notes").json() if item["id"] == note_id)

    def test_a_note_without_a_chosen_icon_shows_a_guess_then_the_type_default(self):
        trip = self.make("Lisbon trip")
        self.assertEqual(self.listed(trip["id"])["icon"]["emoji"], "✈️")
        self.assertFalse(self.listed(trip["id"])["icon"]["chosen"])
        self.assertEqual(self.client.get(f"/api/notes/{trip['id']}").json()["icon"]["emoji"], "✈️")
        defaults = {note_type: self.listed(self.make("Zzz qqq", note_type)["id"])["icon"]["emoji"] for note_type in ("page", "canvas", "mindmap")}
        self.assertEqual(defaults, {"page": "📄", "canvas": "🎨", "mindmap": "🧠"})

    def test_choosing_an_icon_keeps_it_across_a_reload_and_a_rename(self):
        note = self.make("Lisbon trip")
        result = self.client.patch(f"/api/notes/{note['id']}/icon", json={"icon": "🍋", "tint": 3, "revision": note["revision"]}).json()
        self.assertEqual(result["revision"], note["revision"] + 1)
        self.assertEqual(self.listed(note["id"])["icon"], {"emoji": "🍋", "tint": 3, "chosen": True})
        saved = self.client.put(f"/api/notes/{note['id']}", json={"title": "Porto trip", "revision": result["revision"], "content": note["content"]}).json()
        self.assertEqual(saved["icon"], {"emoji": "🍋", "tint": 3, "chosen": True})  # the save says what the row shows now

    def test_a_tint_left_out_is_picked_for_the_emoji_and_remove_goes_back_to_the_guess(self):
        note = self.make("Lisbon trip")
        first = self.client.patch(f"/api/notes/{note['id']}/icon", json={"icon": "🍋"}).json()
        shown = self.listed(note["id"])["icon"]
        self.assertEqual((shown["emoji"], shown["tint"], shown["chosen"]), ("🍋", tint_of("🍋"), True))
        self.client.patch(f"/api/notes/{note['id']}/icon", json={"icon": "", "revision": first["revision"]})
        self.assertEqual(self.listed(note["id"])["icon"]["emoji"], "✈️")
        self.assertFalse(self.listed(note["id"])["icon"]["chosen"])

    def test_a_guess_follows_a_rename_until_an_icon_is_chosen(self):
        note = self.make("Lisbon trip")
        saved = self.client.put(f"/api/notes/{note['id']}", json={"title": "Grocery list", "revision": note["revision"], "content": note["content"]}).json()
        self.assertEqual(saved["icon"]["emoji"], "🛒")
        self.assertEqual(self.listed(note["id"])["icon"]["emoji"], "🛒")

    def test_something_that_is_not_one_emoji_or_a_stale_revision_is_refused(self):
        note = self.make("Lisbon trip")
        for bad in ("ab", "<b>", "🍋🍋", 7):
            self.assertEqual(self.client.patch(f"/api/notes/{note['id']}/icon", json={"icon": bad}).status_code, 400, bad)
        self.assertEqual(self.client.patch(f"/api/notes/{note['id']}/icon", json={"icon": "🍋", "tint": 9}).status_code, 400)
        self.assertEqual(self.client.patch(f"/api/notes/{note['id']}/icon", json={"icon": "🍋", "revision": 99}).status_code, 409)
        self.assertEqual(self.client.patch("/api/notes/999/icon", json={"icon": "🍋"}).status_code, 404)
        self.assertFalse(self.listed(note["id"])["icon"]["chosen"])

    def test_choosing_an_icon_does_not_move_the_note_up_the_list(self):
        old = self.make("Old")
        self.make("New")
        order = lambda: [item["title"] for item in self.client.get("/api/notes").json()]
        self.assertEqual(order(), ["New", "Old"])
        self.client.patch(f"/api/notes/{old['id']}/icon", json={"icon": "🍋"})
        self.assertEqual(order(), ["New", "Old"])

    def test_the_icon_survives_a_backup_and_an_import(self):
        note = self.make("Grocery ideas")
        plain = self.make("Plain")
        self.client.patch(f"/api/notes/{note['id']}/icon", json={"icon": "🍋", "tint": 4})
        backup = self.client.get("/api/export/workspace").json()
        by_title = {item["title"]: item for item in backup["notes"]}
        self.assertEqual((by_title["Grocery ideas"]["icon"], by_title["Grocery ideas"]["iconTint"]), ("🍋", 4))
        self.assertNotIn("icon", by_title["Plain"])  # nothing chosen: the file carries nothing
        self.assertEqual(self.client.post("/api/import/workspace", json=backup).status_code, 201)
        copies = [item for item in self.client.get("/api/notes").json() if item["title"] == "Grocery ideas" and item["id"] != note["id"]]
        self.assertEqual(copies[0]["icon"], {"emoji": "🍋", "tint": 4, "chosen": True})

    def test_importing_a_backup_from_before_note_icons_leaves_the_guess(self):
        self.make("Lisbon trip")
        backup = self.client.get("/api/export/workspace").json()
        self.assertEqual(self.client.post("/api/import/workspace", json=backup).status_code, 201)
        self.assertEqual({item["icon"]["emoji"] for item in self.client.get("/api/notes").json()}, {"✈️"})

    def test_a_hand_edited_backup_with_a_bad_icon_imports_without_it(self):
        self.make("Lisbon trip")
        backup = self.client.get("/api/export/workspace").json()
        backup["notes"][0].update(icon="<script>", iconTint=99)
        self.assertEqual(self.client.post("/api/import/workspace", json=backup).status_code, 201)
        self.assertEqual([item["icon"]["chosen"] for item in self.client.get("/api/notes").json()], [False, False])

    def test_markdown_export_puts_the_emoji_before_the_title(self):
        note = self.make("Grocery ideas")
        self.client.patch(f"/api/notes/{note['id']}/icon", json={"icon": "🍋"})
        self.make("Plain")
        with zipfile.ZipFile(io.BytesIO(self.client.get("/api/export/markdown").content)) as archive:
            files = {name: archive.read(name).decode("utf-8") for name in archive.namelist() if name.endswith(".md") and name != "README.md"}
        first_lines = {name.rsplit("/", 1)[-1]: text.splitlines()[0] for name, text in files.items()}
        self.assertEqual(first_lines["grocery-ideas.md"], "# 🍋 Grocery ideas")
        self.assertEqual(first_lines["plain.md"], "# Plain")  # only a chosen icon is exported: a guess is not part of the note

    def test_an_existing_database_without_the_columns_migrates_to_no_chosen_icon(self):
        legacy = Path(self.temporary_directory.name) / "legacy.db"
        connection = sqlite3.connect(legacy)
        connection.execute("CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL DEFAULT 'Untitled note', content TEXT NOT NULL DEFAULT '{\"objects\":[]}', page_state TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
        connection.execute("INSERT INTO notes (title) VALUES ('Lisbon trip')")
        connection.commit()
        connection.close()
        with TestClient(create_app(legacy)) as client:
            self.assertEqual([item["icon"] for item in client.get("/api/notes").json()], [{"emoji": "✈️", "tint": tint_of("✈️"), "chosen": False}])


class NoteIconCliTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temporary_directory.name) / "personal-note.db"

    def tearDown(self):
        self.temporary_directory.cleanup()

    def run_cli(self, *arguments):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = main(["--database", str(self.database_path), *arguments])
        return code, json.loads(output.getvalue())

    def test_notes_update_sets_and_removes_an_icon(self):
        _, note = self.run_cli("notes", "create", "--title", "Lisbon trip", "--type", "page")
        code, result = self.run_cli("notes", "update", str(note["id"]), "--icon", "🍋", "--tint", "2")
        self.assertEqual((code, result["icon"]), (0, {"emoji": "🍋", "tint": 2, "chosen": True}))
        _, listed = self.run_cli("notes", "list")
        self.assertEqual(listed[0]["icon"], {"emoji": "🍋", "tint": 2, "chosen": True})
        _, cleared = self.run_cli("notes", "update", str(note["id"]), "--icon", "none")
        self.assertEqual(cleared["icon"]["emoji"], "✈️")
        self.assertFalse(cleared["icon"]["chosen"])

    def test_a_revision_that_is_out_of_date_or_text_that_is_not_an_emoji_is_refused(self):
        _, note = self.run_cli("notes", "create", "--title", "Trip", "--type", "page")
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            main(["--database", str(self.database_path), "notes", "update", str(note["id"]), "--icon", "abc"])
        with contextlib.redirect_stderr(io.StringIO()):
            code = main(["--database", str(self.database_path), "notes", "update", str(note["id"]), "--icon", "🍋", "--revision", "9"])
        self.assertNotEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
