import copy
import json
import shutil
import subprocess
import unittest
from pathlib import Path

import document_model as dm
from note_text import canvas_plain_text, note_plain_text
from services import NoteService

ROOT = Path(__file__).resolve().parent.parent
FIXTURE_DIR = ROOT / "tests" / "fixtures" / "documents"
FIXTURES = [json.loads(path.read_text()) for path in sorted(FIXTURE_DIR.glob("*.json"))]
BY_NAME = {fixture["name"]: fixture for fixture in FIXTURES}
WITHOUT_IDS = {"edge-ids", "edge-unknown", "benchmark-600"}


def model_of(name):
    fixture = BY_NAME[name]
    return dm.from_fabric(fixture["content"], fixture["pageState"])


def of_type(doc, kind):
    return [obj for obj in doc["objects"] if obj["type"] == kind]


class RoundTripTests(unittest.TestCase):
    def test_every_fixture_comes_back_unchanged(self):
        self.assertGreaterEqual(len(FIXTURES), 9)
        for fixture in FIXTURES:
            with self.subTest(fixture["name"]):
                doc = dm.from_fabric(fixture["content"], fixture["pageState"])
                self.assertEqual(dm.to_fabric(doc), fixture["content"])
                self.assertEqual(dm.page_state_of(doc), fixture["pageState"])

    def test_the_round_trip_survives_json(self):
        for fixture in FIXTURES:
            with self.subTest(fixture["name"]):
                doc = json.loads(json.dumps(dm.from_fabric(fixture["content"], fixture["pageState"])))
                self.assertEqual(dm.to_fabric(doc), fixture["content"])

    def test_explicit_null_properties_are_not_confused_with_absent_ones(self):
        content = {"objects": [{"type": "Rect", "stroke": None, "fill": None, "rx": 0, "semanticId": "a"}, {"type": "Rect", "semanticId": "b"}]}
        self.assertEqual(dm.to_fabric(dm.from_fabric(content)), content)

    def test_the_model_shares_nothing_with_its_input(self):
        fixture = BY_NAME["app-all-tools"]
        before = copy.deepcopy(fixture["content"])
        doc = dm.from_fabric(fixture["content"], fixture["pageState"])
        of_type(doc, "ink")[0]["points"][0]["x"] = -999
        dm.to_fabric(doc)["objects"][0]["left"] = -1
        self.assertEqual(fixture["content"], before)

    def test_unknown_objects_are_kept_verbatim(self):
        doc = model_of("edge-unknown")
        original = BY_NAME["edge-unknown"]["content"]["objects"]
        unknown = of_type(doc, "unknown")
        self.assertEqual(len(unknown), 8)
        for entry in unknown:
            self.assertEqual(entry["raw"], original[entry["z"]])

    def test_groups_circles_and_stray_fields(self):
        doc = model_of("edge-unknown")
        [group] = of_type(doc, "group")
        self.assertEqual([child["type"] for child in group["children"]], ["shape", "text"])
        circle = next(obj for obj in of_type(doc, "shape") if obj["id"] == "res_circle_1")
        self.assertEqual((circle["kind"], circle["radius"]), ("circle", 30))
        custom = next(obj for obj in of_type(doc, "shape") if obj["id"] == "res_custom_1")
        self.assertEqual(custom["extras"]["futureField"], {"kept": True, "nested": [1, 2, 3]})

    def test_highlighter_alpha_and_ink_dots(self):
        strokes = [ink for ink in of_type(model_of("app-all-tools"), "ink") if ink["kind"] == "stroke" and ink["tool"] == "highlight"]
        self.assertTrue(strokes)
        self.assertAlmostEqual(strokes[0]["alpha"], 0x55 / 255)
        dots = of_type(model_of("ink-dots"), "ink")
        self.assertEqual([dot["kind"] for dot in dots], ["dot"] * 3)
        self.assertEqual(dots[2]["color"], "#d0021b")

    def test_colours_that_are_not_hex_with_alpha_are_not_rewritten(self):
        for stroke in ("#20201E55", "rgba(1,2,3,0.5)", "red", "#223", "#2020aa"):
            content = {"objects": [{"type": "Path", "isInk": True, "path": [["M", 0, 0]], "stroke": stroke, "semanticId": "a"}]}
            self.assertEqual(dm.to_fabric(dm.from_fabric(content)), content, stroke)

    def test_media_library_pictures_need_a_resolver(self):
        doc = model_of("app-objects")
        data_url = of_type(doc, "image")[0]["mediaRef"]["dataUrl"]
        stored = copy.deepcopy(doc)
        of_type(stored, "image")[0]["mediaRef"] = {"kind": "media", "id": "med_123"}
        self.assertTrue(dm.validate_document(stored)["ok"])
        with self.assertRaisesRegex(dm.DocumentError, "med_123"):
            dm.to_fabric(stored)
        resolved = dm.to_fabric(stored, resolve_media=lambda ref: data_url if ref["id"] == "med_123" else None)
        self.assertEqual(resolved, BY_NAME["app-objects"]["content"])

    def test_stacking_order_follows_z(self):
        doc = model_of("app-text")
        first, second = doc["objects"]
        swapped = {**doc, "objects": [{**first, "z": 1}, {**second, "z": 0}]}
        out = dm.to_fabric(swapped)
        self.assertEqual([obj["semanticId"] for obj in out["objects"]], [second["id"], first["id"]])


class ValidationTests(unittest.TestCase):
    def test_real_notes_are_valid_and_the_hand_made_ones_only_lack_ids(self):
        for fixture in FIXTURES:
            doc = dm.from_fabric(fixture["content"], fixture["pageState"])
            with self.subTest(fixture["name"]):
                if fixture["name"] in WITHOUT_IDS:
                    self.assertFalse(dm.validate_document(doc)["ok"])
                    self.assertEqual(dm.validate_document(doc, require_ids=False)["errors"], [])
                else:
                    self.assertEqual(dm.validate_document(doc)["errors"], [])

    def test_duplicate_missing_and_empty_ids_are_reported(self):
        text = "\n".join(f"{e['path']}: {e['message']}" for e in dm.validate_document(model_of("edge-ids"))["errors"])
        self.assertIn("objects[1].id: duplicate id", text)
        self.assertIn("objects[2].id: missing id", text)
        self.assertIn("objects[3].id: empty id", text)

    def test_errors_name_the_path_and_the_problem(self):
        doc = dm.empty_document()
        doc["objects"] += [
            {"id": "a", "type": "text", "z": 0, "geometry": {"x": "left"}, "content": 5},
            {"id": "b", "type": "sticky", "z": 0, "geometry": {}, "content": "x"},
            {"id": "c", "type": "shape", "z": 2, "geometry": {}, "kind": "blob"},
            {"id": "d", "type": "ink", "z": 3, "geometry": {}, "kind": "stroke", "points": [{"x": 1}]},
            {"id": "e", "type": "image", "z": 4, "geometry": {}, "mediaRef": {"kind": "url"}},
            {"id": "f", "type": "connector", "z": 5, "geometry": {}, "fromId": "a"},
            {"id": "g", "type": "group", "z": 6, "geometry": {}, "children": "no"},
            {"id": "h", "type": "sparkle", "z": 7},
            {"id": "i", "type": "unknown", "z": 8},
        ]
        doc["page"]["columns"] = 0
        messages = [f"{e['path']}: {e['message']}" for e in dm.validate_document(doc)["errors"]]
        for line in [
            "page.columns: must be a whole number of at least 1",
            "objects[0].geometry.x: must be a finite number",
            "objects[0].content: must be a string",
            "objects[1].z: duplicate z (also used by objects[0])",
            "objects[1].color: sticky needs a colour",
            "objects[2].kind: must be one of rect, circle",
            "objects[3].points[0].y: must be a finite number",
            "objects[4].mediaRef.kind: must be inline or media",
            "objects[5].toId: connector needs a toId",
            "objects[6].children: must be an array",
            "objects[7].type: unknown object type 'sparkle'",
            "objects[8].raw: unknown objects must keep their raw value",
        ]:
            self.assertIn(line, messages)

    def test_to_fabric_refuses_an_invalid_document(self):
        with self.assertRaises(dm.DocumentError):
            dm.to_fabric({"schemaVersion": 1, "page": {"columns": 1, "rows": 1}, "objects": [{"type": "sparkle", "z": 0}]})
        self.assertFalse(dm.validate_document({"schemaVersion": 99, "page": {"columns": 1, "rows": 1}, "objects": []})["ok"])
        self.assertFalse(dm.validate_document(None)["ok"])


class TextReadersTests(unittest.TestCase):
    """F-026 swaps the readers onto the model; search and agent text must not change."""

    def test_plain_text_equals_note_text_on_every_fixture(self):
        for fixture in FIXTURES:
            with self.subTest(fixture["name"]):
                doc = dm.from_fabric(fixture["content"], fixture["pageState"])
                self.assertEqual(dm.plain_text(doc), canvas_plain_text(fixture["content"]))
                self.assertEqual(dm.plain_text(doc), note_plain_text({"noteType": "canvas", "content": fixture["content"]}))

    def test_search_text_equals_the_search_index_text_on_every_fixture(self):
        for fixture in FIXTURES:
            with self.subTest(fixture["name"]):
                doc = dm.from_fabric(fixture["content"], fixture["pageState"])
                self.assertEqual(dm.search_text(doc), NoteService.canvas_text(json.dumps(fixture["content"])))

    def test_the_text_readers_agree_on_awkward_notes(self):
        content = {"objects": [
            {"type": "Textbox", "text": "  low  ", "top": "300", "left": 5},
            {"type": "IText", "text": "high", "top": 10, "left": "x"},
            {"type": "Rect", "text": "stray text on a rectangle", "top": 10, "left": 0},
            {"type": "Triangle", "text": "unknown with text", "top": 10, "left": 1},
            {"type": "Textbox", "text": "   ", "top": 0},
            {"type": "Sticky", "text": "tie a", "top": 50, "left": 50},
            {"type": "Sticky", "text": "tie b", "top": 50, "left": 50},
            {"type": "Textbox", "text": 5, "top": 0},
            "junk", None, 7,
        ]}
        doc = dm.from_fabric(content)
        self.assertEqual(dm.plain_text(doc), canvas_plain_text(content))
        self.assertEqual(dm.search_text(doc), NoteService.canvas_text(json.dumps(content)))

    def test_text_in_a_cli_appended_note_reads_in_order(self):
        text = dm.plain_text(model_of("cli-created"))
        self.assertTrue(text.startswith("Keep a searchable local idea\n\nSecond thought\nwith two lines"))


class JavaScriptParityTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_python_and_javascript_build_the_same_model_from_every_fixture(self):
        result = subprocess.run(["node", str(ROOT / "scripts" / "dump-document-models.mjs")], capture_output=True, text=True, check=True, cwd=ROOT)
        js_models = json.loads(result.stdout)
        self.assertEqual(set(js_models), set(BY_NAME))
        for name, js_model in js_models.items():
            with self.subTest(name):
                self.assertEqual(model_of(name), js_model)


if __name__ == "__main__":
    unittest.main()
