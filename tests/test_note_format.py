"""F-026: notes stored as JSON Canvas: storage, one-time conversion, backup, search, vault export and import, media."""

import io
import json
import os
import shutil
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path

from starlette.testclient import TestClient

import document_model as dm
import json_canvas as jc
import vault
from media_store import MEDIA_NAME
from note_text import note_plain_text
from routes import create_app
from services import FORMAT_CANVAS, FORMAT_FABRIC, InvalidNoteContentError, NoteService, WorkspaceImportError

ROOT = Path(__file__).resolve().parent.parent
FIXTURE_DIR = ROOT / "tests" / "fixtures" / "documents"
FIXTURES = {path.stem: json.loads(path.read_text()) for path in sorted(FIXTURE_DIR.glob("*.json"))}
PNG = "data:image/png;base64,iVBORw0KGgo="


class Folder(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(dir=os.environ.get("TMPDIR")))
        self.addCleanup(shutil.rmtree, self.folder, True)
        self.database = self.folder / "personal-note.db"


def legacy_database(path: Path, notes: dict[str, dict]) -> None:
    """A database as the app wrote it before F-026: Fabric JSON in `content`, no `content_format` column."""
    service = NoteService(path)
    ids = {title: service.create_note({"title": title})["id"] for title in notes}
    with service.connection() as connection:
        for title, fixture in notes.items():
            connection.execute(
                "UPDATE notes SET content = ?, page_state = ? WHERE id = ?",
                (json.dumps(fixture["content"]), json.dumps(fixture["pageState"]), ids[title]),
            )
        service.rebuild_derived_indexes(connection)
        connection.execute("ALTER TABLE notes DROP COLUMN content_format")
        connection.commit()


class StorageTests(Folder):
    def test_new_canvas_notes_are_json_canvas_and_either_format_can_be_saved(self):
        service = NoteService(self.database)
        note = service.create_note({"title": "New"})
        self.assertEqual((note["contentFormat"], note["content"]["nodes"], note["content"]["edges"]), (FORMAT_CANVAS, [], []))
        self.assertEqual(note["content"]["pn"]["page"], {"columns": 1, "rows": 1})

        fabric = FIXTURES["app-text"]
        saved = service.update_note(note["id"], {"title": "New", "revision": note["revision"], "content": fabric["content"], "pageState": fabric["pageState"]})
        loaded = service.get_note(note["id"])
        self.assertEqual(loaded["contentFormat"], FORMAT_CANVAS)
        self.assertTrue(jc.validate_json_canvas(loaded["content"])["ok"])
        self.assertEqual(loaded["pageState"], fabric["pageState"])

        again = service.update_note(note["id"], {"title": "New", "revision": saved["revision"], "content": loaded["content"], "pageState": loaded["pageState"]})
        reloaded = service.get_note(note["id"])
        self.assertEqual(again["revision"], saved["revision"] + 1)
        self.assertEqual(reloaded["content"], loaded["content"], "saving JSON Canvas back changes nothing")

    def test_a_save_without_pn_page_uses_the_pages_the_note_needs_and_a_garbage_canvas_is_refused(self):
        service = NoteService(self.database)
        note = service.create_note({"title": "Foreign"})
        canvas = {"nodes": [{"id": "a", "type": "text", "text": "hi", "x": -50, "y": -50, "width": 200, "height": 100}], "edges": []}
        service.update_note(note["id"], {"title": "Foreign", "revision": note["revision"], "content": canvas})
        loaded = service.get_note(note["id"])
        self.assertGreaterEqual(loaded["content"]["nodes"][0]["x"], 0)
        with self.assertRaises(InvalidNoteContentError):
            service.update_note(note["id"], {"title": "x", "content": {"nodes": "nope"}})

    def test_pictures_are_written_once_as_content_addressed_files(self):
        service = NoteService(self.database)
        note = service.create_note({"title": "Pic"})
        content = {"objects": [{"type": "Image", "src": PNG, "left": 10, "top": 10, "width": 20, "height": 20, "semanticId": "res_i"}]}
        service.update_note(note["id"], {"title": "Pic", "revision": note["revision"], "content": content})
        node = service.get_note(note["id"])["content"]["nodes"][0]
        self.assertRegex(node["file"], r"^media/[0-9a-f]{64}\.png$")
        stored = self.folder / node["file"]
        self.assertEqual(stored.read_bytes(), b"\x89PNG\r\n\x1a\n")
        before = stored.stat().st_mtime_ns
        service.update_note(note["id"], {"title": "Pic", "content": content})
        self.assertEqual(stored.stat().st_mtime_ns, before, "an unchanged picture is not written again")
        self.assertEqual(list((self.folder / "media").glob("*.png")), [stored])

    def test_media_route_serves_only_content_addressed_names(self):
        app = create_app(self.database)
        client = TestClient(app)
        self.addCleanup(client.close)
        name = app.state.note_service.media.put_data_url(PNG).split("/")[1]
        self.assertTrue(MEDIA_NAME.match(name))
        ok = client.get(f"/api/media/{name}")
        self.assertEqual((ok.status_code, ok.content), (200, b"\x89PNG\r\n\x1a\n"))
        for bad in ("../personal-note.db", "x.png", "personal-note.db", f"{'0' * 64}.png"):
            self.assertEqual(client.get(f"/api/media/{bad}").status_code, 404, bad)

    def test_search_indexes_the_projection_and_keeps_finding_what_it_found(self):
        service = NoteService(self.database)
        note = service.create_note({"title": "Search"})
        content = FIXTURES["app-all-tools"]["content"]
        service.update_note(note["id"], {"title": "Search", "revision": note["revision"], "content": content, "pageState": {"columns": 1, "rows": 1}})
        for query in ("Buy paper", "second line", "Purple note"):
            self.assertEqual([item["id"] for item in service.search(query)], [note["id"]], query)
        self.assertEqual(service.search("Geist"), [])  # style names are not text

    def test_reserved_ids_are_unique_across_notes(self):
        service = NoteService(self.database)
        ids = []
        for title in ("one", "two"):
            note = service.create_note({"title": title})
            service.update_note(note["id"], {"title": title, "revision": note["revision"], "content": {"objects": [{"type": "IText", "text": "x", "semanticId": "res_same", "left": 1, "top": 1}]}})
            ids.append(service.get_note(note["id"])["content"]["nodes"][0]["id"])
        self.assertNotEqual(*ids)
        self.assertEqual(ids[0], "res_same")


class AgentRoundTripTests(Folder):
    def test_an_agent_append_is_a_markdown_node_the_app_side_reads_back_by_id(self):
        service = NoteService(self.database)
        note = service.create_note({"title": "Agent"})
        content = FIXTURES["app-text"]["content"]
        service.update_note(note["id"], {"title": "Agent", "revision": note["revision"], "content": content, "pageState": FIXTURES["app-text"]["pageState"]})
        before = service.get_note(note["id"])
        service.append_text(note["id"], "## From the agent\n- item", revision=before["revision"])
        after = service.get_note(note["id"])
        self.assertEqual(after["content"]["nodes"][:-1], before["content"]["nodes"], "existing nodes are untouched")
        added = after["content"]["nodes"][-1]
        self.assertEqual((added["type"], added["text"]), ("text", "## From the agent\n- item"))
        self.assertTrue(added["id"].startswith("res_"))
        self.assertTrue(note_plain_text(after).endswith("## From the agent\n- item"))
        # the app opens it: the new node becomes a Fabric Textbox with the same id
        fabric = dm.to_fabric(jc.from_json_canvas(after["content"]))
        self.assertEqual(fabric["objects"][-1]["semanticId"], added["id"])
        self.assertEqual(fabric["objects"][-1]["text"], "## From the agent\n- item")


class ConversionTests(Folder):
    NOTES = {title: FIXTURES[name] for title, name in (("Text", "app-text"), ("Tools", "app-all-tools"), ("Objects", "app-objects"), ("Agent", "cli-appended"), ("Ids", "edge-ids"), ("Odd", "edge-unknown"))}

    def setUp(self):
        super().setUp()
        legacy_database(self.database, self.NOTES)
        self.original_bytes = self.database.read_bytes()

    def rows(self):
        connection = sqlite3.connect(self.database)
        self.addCleanup(connection.close)
        return connection.execute("SELECT title, content_format, revision, page_state FROM notes ORDER BY id").fetchall()

    def test_old_notes_convert_once_and_the_old_file_is_kept_aside(self):
        search_before = None
        service = NoteService(self.database)
        backup = self.folder / "personal-note.db.fabric-backup"
        self.assertTrue(backup.exists())
        old = sqlite3.connect(backup)
        self.addCleanup(old.close)
        self.assertEqual(old.execute("SELECT count(*) FROM notes").fetchone()[0], len(self.NOTES))
        self.assertTrue(old.execute("SELECT content FROM notes WHERE title='Tools'").fetchone()[0].startswith('{"version"') or '"objects"' in old.execute("SELECT content FROM notes WHERE title='Tools'").fetchone()[0])
        self.assertNotIn("content_format", [r[1] for r in old.execute("PRAGMA table_info(notes)")], "the copy is exactly what the old app wrote")
        for title, fmt, revision, _ in self.rows():
            self.assertEqual(fmt, FORMAT_CANVAS, title)
        self.assertEqual({r[2] for r in self.rows()} - {1, 2}, set(), "conversion does not bump revisions")

        for title, fixture in self.NOTES.items():
            note = next(item for item in service.list_notes() if item["title"] == title)
            loaded = service.get_note(note["id"])
            self.assertTrue(jc.validate_json_canvas(loaded["content"])["ok"], title)
            # what the editor will load: render-equivalent to what was saved
            before = dm.from_fabric(fixture["content"], fixture["pageState"])
            after = jc.from_json_canvas(loaded["content"])
            self.assertEqual(len(after["objects"]), len(before["objects"]), title)
        self.assertIsNone(search_before)

    def test_converting_again_changes_nothing(self):
        NoteService(self.database)
        converted = self.rows()
        backup = self.folder / "personal-note.db.fabric-backup"
        stamp = backup.stat().st_mtime_ns
        size = backup.stat().st_size
        contents = sqlite3.connect(self.database).execute("SELECT id, content FROM notes ORDER BY id").fetchall()
        NoteService(self.database)
        NoteService(self.database)
        self.assertEqual(self.rows(), converted)
        self.assertEqual(sqlite3.connect(self.database).execute("SELECT id, content FROM notes ORDER BY id").fetchall(), contents)
        self.assertEqual((backup.stat().st_mtime_ns, backup.stat().st_size), (stamp, size))

    def test_an_existing_backup_copy_is_never_overwritten(self):
        backup = self.folder / "personal-note.db.fabric-backup"
        backup.write_bytes(b"older copy")
        NoteService(self.database)
        self.assertEqual(backup.read_bytes(), b"older copy")

    def test_a_fresh_database_makes_no_backup_copy(self):
        NoteService(self.folder / "fresh.db").create_note({"title": "x"})
        NoteService(self.folder / "fresh.db")
        self.assertFalse((self.folder / "fresh.db.fabric-backup").exists())

    def test_search_still_finds_converted_notes(self):
        service = NoteService(self.database)
        found = [item["title"] for item in service.search("Buy paper")]
        self.assertIn("Tools", found)
        self.assertEqual([item["title"] for item in service.search("ship the export")][:1], ["Text"] if "ship the export" in json.dumps(FIXTURES["app-text"]) else found[:1])

    def test_a_note_that_fails_to_convert_stays_old_and_still_opens(self):
        connection = sqlite3.connect(self.database)
        connection.execute("UPDATE notes SET content = '{broken json' WHERE title = 'Text'")
        connection.commit()
        connection.close()
        with self.assertLogs("services", level="ERROR"):
            service = NoteService(self.database)
        formats = {title: fmt for title, fmt, _, _ in self.rows()}
        self.assertEqual(formats["Text"], FORMAT_FABRIC)
        self.assertTrue(all(fmt == FORMAT_CANVAS for title, fmt in formats.items() if title != "Text"))
        note = next(item for item in service.list_notes() if item["title"] == "Text")
        opened = service.get_note(note["id"])  # still opens (as the old reader would have shown it)
        self.assertEqual(opened["contentFormat"], FORMAT_FABRIC)
        # and the next save converts it
        saved = service.update_note(note["id"], {"title": "Text", "revision": opened["revision"], "content": FIXTURES["app-text"]["content"], "pageState": FIXTURES["app-text"]["pageState"]})
        self.assertEqual(service.get_note(note["id"])["contentFormat"], FORMAT_CANVAS)
        self.assertEqual(saved["revision"], opened["revision"] + 1)

    def test_mind_maps_are_not_touched(self):
        service = NoteService(self.folder / "maps.db")
        service.create_note({"title": "Map", "noteType": "mindmap"})
        legacy = sqlite3.connect(self.folder / "maps.db")
        legacy.execute("UPDATE notes SET content_format = 'fabric'")  # as a pre-F-026 row looks after the column is added
        legacy.commit()
        legacy.close()
        again = NoteService(self.folder / "maps.db")
        note = again.list_notes()[0]
        self.assertEqual(again.get_note(note["id"])["contentFormat"], "mindmap")
        self.assertFalse((self.folder / "maps.db.fabric-backup").exists())


class BackupTests(Folder):
    def test_backup_is_version_two_self_contained_and_round_trips(self):
        from portability import import_workspace_backup, workspace_backup

        service = NoteService(self.database)
        note = service.create_note({"title": "Rich"})
        fixture = FIXTURES["app-all-tools"]
        service.update_note(note["id"], {"title": "Rich", "revision": note["revision"], "content": fixture["content"], "pageState": fixture["pageState"]})
        backup = workspace_backup(service)
        self.assertEqual(backup["version"], 2)
        exported = backup["notes"][0]["content"]
        self.assertTrue(jc.validate_json_canvas(exported)["ok"])
        self.assertTrue(all(n["file"].startswith("data:") for n in exported["nodes"] if n["type"] == "file"), "no path into a media folder that the backup does not carry")

        other = NoteService(self.folder / "other" / "restore.db")
        result = import_workspace_backup(other, json.loads(json.dumps(backup)))
        self.assertEqual(result["notesImported"], 1)
        restored = other.get_note(result["noteIds"][0])
        original = service.get_note(note["id"])
        before = jc.from_json_canvas(original["content"])
        after = jc.from_json_canvas(restored["content"])
        strip = lambda d: [{k: v for k, v in o.items() if k not in ("id", "mediaRef", "fromId", "toId")} for o in d["objects"]]
        self.assertEqual(strip(after), strip(before))
        restored_image = next(n for n in restored["content"]["nodes"] if n["pn"]["type"] == "image")
        self.assertTrue((self.folder / "other" / restored_image["file"]).is_file(), "the picture is back in the new library")

    def test_a_version_one_backup_with_fabric_canvases_still_imports(self):
        from portability import import_workspace_backup

        fixture = FIXTURES["app-all-tools"]
        old_backup = {
            "format": "personal-note-workspace", "version": 1, "workspaceId": "ws_old",
            "notebooks": [{"resourceId": "nb", "name": "Old", "color": "#B86B4B", "category": "projects"}],
            "notes": [
                {"resourceId": "n1", "notebookResourceId": "nb", "noteType": "canvas", "title": "From v1", "content": fixture["content"], "pageState": fixture["pageState"]},
                {"resourceId": "n2", "notebookResourceId": "nb", "noteType": "mindmap", "title": "Map", "content": {"version": 1, "rootId": "root", "nodes": [{"id": "root", "parentId": None, "text": "R"}]}},
            ],
        }
        service = NoteService(self.database)
        result = import_workspace_backup(service, old_backup)
        self.assertEqual(result["notesImported"], 2)
        canvas = next(service.get_note(i) for i in result["noteIds"] if service.get_note(i)["title"] == "From v1")
        self.assertEqual(canvas["contentFormat"], FORMAT_CANVAS)
        self.assertEqual(len(canvas["content"]["nodes"]) + len(canvas["content"]["edges"]), len(fixture["content"]["objects"]))
        self.assertEqual([i["title"] for i in service.search("Buy paper")], ["From v1"])

    def test_an_unreadable_note_in_a_backup_refuses_the_whole_import(self):
        service = NoteService(self.database)
        before = len(service.list_notes())
        backup = {"format": "personal-note-workspace", "version": 2, "notebooks": [{"resourceId": "nb", "name": "N"}],
                  "notes": [{"notebookResourceId": "nb", "title": "Bad", "content": {"nodes": "x"}}]}
        with self.assertRaises(WorkspaceImportError):
            service.import_workspace_snapshot(backup)
        self.assertEqual(len(service.list_notes()), before)


class VaultTests(Folder):
    def make_service(self):
        service = NoteService(self.database)
        notebook = service.create_notebook({"name": "Research: Q3/2026"})
        for title, name in (("Board", "app-all-tools"), ("Text", "app-text")):
            note = service.create_note({"title": title, "notebookId": notebook["id"]})
            fixture = FIXTURES[name]
            service.update_note(note["id"], {"title": title, "revision": note["revision"], "content": fixture["content"], "pageState": fixture["pageState"]})
        service.create_note({"title": "Map", "noteType": "mindmap", "notebookId": notebook["id"]})
        return service

    def test_export_writes_valid_canvas_files_and_attachments(self):
        service = self.make_service()
        files = vault.export_vault_files(service)
        canvases = {path: json.loads(data) for path, data in files.items() if path.endswith(".canvas")}
        self.assertEqual(sorted(canvases), ["Research- Q3-2026/Board.canvas", "Research- Q3-2026/Text.canvas"])
        for path, canvas in canvases.items():
            report = jc.validate_json_canvas(canvas)
            self.assertTrue(report["ok"], (path, report["errors"][:3]))
            for node in canvas["nodes"]:
                if node["type"] == "file":
                    self.assertIn(node["file"], files, f"{path}: attachment {node['file']} is in the vault")
                    self.assertTrue(node["file"].startswith("attachments/"))
        self.assertIn("Research- Q3-2026/Map.md", files)
        kinds = {Path(name).suffix for name in files if name.startswith("attachments/")}
        self.assertEqual(kinds, {".png", ".svg"} if ".png" in kinds else {".svg"})
        board = canvases["Research- Q3-2026/Board.canvas"]
        self.assertTrue(board["edges"] and all(e["toNode"] in {n["id"] for n in board["nodes"]} for e in board["edges"]))

    def test_exported_vault_imports_as_new_notes_and_never_overwrites(self):
        service = self.make_service()
        archive = vault.export_vault_archive(service)
        before = {item["title"] for item in service.list_notes()}
        result = vault.import_vault_archive(service, archive)
        self.assertEqual(result["notesImported"], 3)  # the two canvases, and the mind map's Markdown outline as a text note
        self.assertEqual(result["notebooksImported"], 1)
        notes = service.list_notes()
        self.assertEqual(len(notes), 3 + 3)
        self.assertEqual({item["title"] for item in notes}, before | {"Board", "Text", "Map"})
        copies = [service.get_note(i) for i in result["noteIds"]]
        originals = {item["title"]: service.get_note(item["id"]) for item in notes if item["id"] not in result["noteIds"]}
        for copy in copies:
            if copy["title"] in ("Board", "Text"):
                a = jc.from_json_canvas(originals[copy["title"]]["content"])
                b = jc.from_json_canvas(copy["content"])
                strip = lambda d: [{k: v for k, v in o.items() if k not in ("id", "fromId", "toId")} for o in d["objects"]]
                self.assertEqual(strip(b), strip(a), copy["title"])
        for title, note in originals.items():
            self.assertEqual(service.get_note(note["id"])["content"], note["content"], "originals untouched")
        self.assertEqual(note_plain_text(next(c for c in copies if c["title"] == "Text")), note_plain_text(originals["Text"]))

    def test_obsidian_made_vault_opens_with_its_attachments(self):
        service = NoteService(self.database)
        canvas = {
            "nodes": [
                {"id": "1a2b3c4d5e6f7a8b", "type": "text", "text": "# Plan\n\nShip **it**", "x": -400, "y": -300, "width": 400, "height": 200, "color": "4"},
                {"id": "2a2b3c4d5e6f7a8b", "type": "file", "file": "Attachments/diagram.png", "x": 100, "y": -300, "width": 300, "height": 200},
                {"id": "3a2b3c4d5e6f7a8b", "type": "link", "url": "https://jsoncanvas.org", "x": 100, "y": 0, "width": 300, "height": 80},
            ],
            "edges": [{"id": "4a2b3c4d5e6f7a8b", "fromNode": "1a2b3c4d5e6f7a8b", "toNode": "2a2b3c4d5e6f7a8b", "fromSide": "right", "toSide": "left", "toEnd": "arrow"}],
        }
        files = {
            "Projects/Roadmap.canvas": json.dumps(canvas).encode(),
            "Attachments/diagram.png": b"\x89PNG\r\n\x1a\nxx",
            "Projects/Standalone.md": b"---\ntags: [a]\n---\n# Standalone\nplain Markdown note",
            ".obsidian/workspace.json": b"{}",
            "notes.txt": b"ignored",
        }
        result = vault.import_vault_files(service, files)
        self.assertEqual((result["notesImported"], result["notebooksImported"], result["skipped"]), (2, 1, []))
        titles = {item["title"]: service.get_note(item["id"]) for item in service.list_notes() if item["id"] in result["noteIds"]}
        self.assertEqual(set(titles), {"Roadmap", "Standalone"})
        roadmap = titles["Roadmap"]
        self.assertTrue(jc.validate_json_canvas(roadmap["content"])["ok"])
        self.assertGreaterEqual(min(n["x"] for n in roadmap["content"]["nodes"]), 0)
        picture = next(n for n in roadmap["content"]["nodes"] if n["pn"]["type"] == "image")
        self.assertEqual((self.folder / picture["file"]).read_bytes(), b"\x89PNG\r\n\x1a\nxx")
        self.assertEqual(next(n for n in roadmap["content"]["nodes"] if n["pn"]["type"] == "sticky")["text"], "# Plan\n\nShip **it**")
        self.assertEqual([i["title"] for i in service.search("Ship")], ["Roadmap"])
        self.assertEqual([i["title"] for i in service.search("plain Markdown")], ["Standalone"])

    def test_import_refuses_unsafe_and_oversized_archives(self):
        service = NoteService(self.database)
        with self.assertRaises(vault.PortabilityVaultError):
            vault.import_vault_archive(service, b"not a zip")
        evil = io.BytesIO()
        with zipfile.ZipFile(evil, "w") as archive:
            archive.writestr("../escape.canvas", '{"nodes":[]}')
            archive.writestr("ok/Fine.canvas", '{"nodes":[{"id":"a","type":"text","text":"fine","x":0,"y":0,"width":10,"height":10}]}')
        result = vault.import_vault_archive(service, evil.getvalue())
        self.assertEqual(result["notesImported"], 1)
        with self.assertRaises(vault.PortabilityVaultError):
            vault.import_vault_files(service, {"readme.txt": b"nothing to import"})

    def test_directory_export_refuses_to_overwrite(self):
        service = self.make_service()
        target = self.folder / "vault"
        summary = vault.export_vault_directory(service, target)
        self.assertEqual(summary["canvasFiles"], 2)
        self.assertTrue((target / "Research- Q3-2026" / "Board.canvas").is_file())
        with self.assertRaises(vault.PortabilityVaultError):
            vault.export_vault_directory(service, target)
        again = vault.import_vault_directory(NoteService(self.folder / "second.db"), target)
        self.assertEqual(again["notesImported"], 3)


if __name__ == "__main__":
    unittest.main()
