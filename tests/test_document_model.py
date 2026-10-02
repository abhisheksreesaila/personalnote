import copy
import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

import document_model as dm
from note_text import canvas_plain_text, note_plain_text
from services import NoteService

ROOT = Path(__file__).resolve().parent.parent
FIXTURE_DIR = ROOT / "tests" / "fixtures" / "documents"
WITHOUT_IDS = {"edge-ids", "edge-unknown", "benchmark-600"}

# The JS build is the second implementation to compare with, and it also builds the seeded 600-object benchmark note (not stored).
HAS_NODE = shutil.which("node") is not None
if not HAS_NODE and os.environ.get("CI"):
    raise RuntimeError("node is required on CI: the document model parity test and the benchmark fixture need it")
JS_DUMP = (
    json.loads(subprocess.run(["node", str(ROOT / "scripts" / "dump-document-models.mjs")], capture_output=True, text=True, check=True, cwd=ROOT).stdout)
    if HAS_NODE
    else None
)

FIXTURES = [json.loads(path.read_text()) for path in sorted(FIXTURE_DIR.glob("*.json"))]
if JS_DUMP:
    benchmark = JS_DUMP["fixtures"]["benchmark-600"]
    FIXTURES.append({"name": "benchmark-600", "content": benchmark["content"], "pageState": benchmark["pageState"]})
BY_NAME = {fixture["name"]: fixture for fixture in FIXTURES}


def model_of(name):
    fixture = BY_NAME[name]
    return dm.from_fabric(fixture["content"], fixture["pageState"])


def of_type(doc, kind):
    return [obj for obj in doc["objects"] if obj["type"] == kind]


def approx_equal(a, b, tolerance=1e-9):
    """Equal, except that numbers may differ by libm rounding between JS and Python."""
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= tolerance
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(approx_equal(a[key], b[key], tolerance) for key in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(approx_equal(x, y, tolerance) for x, y in zip(a, b))
    return a == b


class LegacyReaderTests(unittest.TestCase):
    """Notes saved by the old canvas engine (Fabric JSON) read into the model; the model is never written back as Fabric JSON."""

    def test_every_fixture_reads_with_its_page_state_and_object_count(self):
        self.assertGreaterEqual(len(FIXTURES), 10)
        for fixture in FIXTURES:
            with self.subTest(fixture["name"]):
                doc = dm.from_fabric(fixture["content"], fixture["pageState"])
                self.assertEqual(doc["page"], fixture["pageState"])
                self.assertEqual(len(doc["objects"]), len(fixture["content"]["objects"]))

    def test_the_model_survives_json(self):
        for fixture in FIXTURES:
            with self.subTest(fixture["name"]):
                doc = dm.from_fabric(fixture["content"], fixture["pageState"])
                self.assertEqual(json.loads(json.dumps(doc)), doc)

    def test_explicit_null_properties_are_not_confused_with_absent_ones(self):
        content = {"objects": [{"type": "Rect", "stroke": None, "fill": None, "rx": 0, "semanticId": "a"}, {"type": "Rect", "semanticId": "b"}]}
        first, second = dm.from_fabric(content)["objects"]
        self.assertEqual((first["stroke"], first["fill"], first["cornerRadius"]), (None, None, 0))
        self.assertNotIn("stroke", second)
        self.assertNotIn("fill", second)

    def test_the_model_shares_nothing_with_its_input(self):
        fixture = BY_NAME["app-all-tools"]
        before = copy.deepcopy(fixture["content"])
        doc = dm.from_fabric(fixture["content"], fixture["pageState"])
        of_type(doc, "ink")[0]["points"][0]["x"] = -999
        of_type(doc, "text")[0]["extras"]["stroke"] = "mutated"
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
        self.assertEqual([child["type"] for child in group["children"]], ["shape", "unknown", "text"])
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

    def test_colours_that_are_not_hex_with_alpha_are_kept_whole(self):
        for stroke in ("rgba(1,2,3,0.5)", "red", "#223", "#2020aa"):
            [ink] = dm.from_fabric({"objects": [{"type": "Path", "isInk": True, "path": [["M", 0, 0]], "stroke": stroke, "semanticId": "a"}]})["objects"]
            self.assertEqual(ink["color"], stroke)
            self.assertNotIn("alpha", ink)

    def test_a_media_library_picture_is_a_valid_document(self):
        doc = model_of("app-objects")
        stored = copy.deepcopy(doc)
        of_type(stored, "image")[0]["mediaRef"] = {"kind": "media", "id": "med_123"}
        self.assertTrue(dm.validate_document(stored)["ok"])


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
            'objects[7].type: unknown object type "sparkle"',
            "objects[8].raw: unknown objects must keep their raw value",
        ]:
            self.assertIn(line, messages)

    def test_a_wrong_schema_version_and_a_non_document_are_rejected(self):
        self.assertFalse(dm.validate_document({"schemaVersion": 99, "page": {"columns": 1, "rows": 1}, "objects": []})["ok"])
        self.assertFalse(dm.validate_document(None)["ok"])


class TextReadersTests(unittest.TestCase):
    """F-026 swaps the readers onto the model; search and agent text must not change."""

    def test_plain_text_has_the_same_blocks_as_note_text_on_every_fixture(self):
        for fixture in FIXTURES:
            with self.subTest(fixture["name"]):
                doc = dm.from_fabric(fixture["content"], fixture["pageState"])
                old = [item["text"].strip() for item in fixture["content"]["objects"] if isinstance(item, dict) and isinstance(item.get("text"), str) and item["text"].strip()]
                self.assertEqual(sorted(dm.plain_text_blocks(doc)), sorted(old))

    def test_note_text_reads_the_same_as_the_model_on_every_fixture(self):
        # F-026 moved note_text (agent CLI read, search) onto the model's reading order, so they cannot differ.
        for fixture in FIXTURES:
            with self.subTest(fixture["name"]):
                doc = model_of(fixture["name"])
                self.assertEqual(dm.plain_text(doc), canvas_plain_text(fixture["content"], fixture["pageState"]))

    def test_reading_order_is_by_top_edge_not_by_origin_point(self):
        # app-objects: a sticky (200 tall) and a text block are both centred on the same line. The sticky's top edge is higher,
        # so it now reads first (the old origin-point rule read "Meeting notes: ship the export" first).
        text = canvas_plain_text(BY_NAME["app-objects"]["content"], BY_NAME["app-objects"]["pageState"])
        self.assertEqual(text.split("\n\n")[0], "Purple note")

    def test_the_search_index_text_is_the_reading_order_projection_on_every_fixture(self):
        for fixture in FIXTURES:
            with self.subTest(fixture["name"]):
                doc = dm.from_fabric(fixture["content"], fixture["pageState"])
                indexed = NoteService.canvas_text(json.dumps(fixture["content"]), "fabric", json.dumps(fixture["pageState"]))
                self.assertEqual(indexed, dm.plain_text(doc))
                # the same words as the old stored-order text; only the order moved to top edge first
                self.assertEqual(sorted(indexed.split()), sorted(dm.search_text(doc).split()))

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
        self.assertEqual(dm.plain_text(doc), NoteService.canvas_text(json.dumps(content)))

    def test_text_in_a_cli_appended_note_reads_in_order(self):
        text = dm.plain_text(model_of("cli-created"))
        self.assertTrue(text.startswith("Keep a searchable local idea\n\nSecond thought\nwith two lines"))


class GeometryTests(unittest.TestCase):
    def test_geometry_is_origin_free_with_typed_rotation_scale_flip_and_skew(self):
        doc = dm.from_fabric({"objects": [
            {"type": "Rect", "left": 100, "top": 50, "width": 40, "height": 20, "originX": "center", "originY": "center", "strokeWidth": 0, "angle": 30, "scaleX": 2, "flipX": True, "skewY": 5, "semanticId": "a"},
            {"type": "Rect", "left": 100, "top": 50, "width": 40, "height": 20, "originX": "left", "originY": "top", "strokeWidth": 0, "semanticId": "b"},
        ]})
        centered, corner = (obj["geometry"] for obj in doc["objects"])
        self.assertEqual([centered[k] for k in ("x", "y", "width", "height")], [80, 40, 40, 20])
        self.assertEqual([centered[k] for k in ("rotation", "scaleX", "scaleY", "flipX", "flipY", "skewX", "skewY")], [30, 2, 1, True, False, 0, 5])
        self.assertEqual((corner["x"], corner["y"]), (100, 50))
        self.assertNotIn("originX", centered)

    def test_ink_is_stored_relative_to_its_box(self):
        content = {"objects": [{"type": "Path", "isInk": True, "semanticId": "a", "left": 500, "top": 400, "originX": "center", "originY": "center", "strokeWidth": 3, "stroke": "#000",
                                "path": [["M", 100, 100], ["L", 160, 130]], "inkPoints": [{"x": 100, "y": 100}, {"x": 160, "y": 130}]}]}
        [ink] = dm.from_fabric(content)["objects"]
        self.assertEqual(ink["path"], [["M", 0, 0], ["L", 60, 30]])
        self.assertEqual(ink["points"], [{"x": 0, "y": 0}, {"x": 60, "y": 30}])
        self.assertEqual((ink["geometry"]["x"], ink["geometry"]["y"], ink["geometry"]["width"], ink["geometry"]["height"]), (470, 385, 60, 30))

    def test_group_picture_and_connector_default_to_no_stroke(self):
        def bare(kind, **extra):
            return {"type": kind, "semanticId": kind, "left": 50, "top": 60, "width": 100, "height": 40, "originX": "left", "originY": "top", **extra}

        doc = dm.from_fabric({"objects": [bare("Group", objects=[]), bare("Image", src="data:,"), bare("Connector"), bare("Rect"), bare("Textbox", text="x")]})
        self.assertEqual([obj["geometry"]["x"] for obj in doc["objects"]], [50, 50, 50, 50.5, 50.5])

    def test_a_q_curve_is_measured_the_way_fabric_measures_it(self):
        bounds = dm._path_bounds([["M", 10, 10], ["Q", 20, 30, 40, 10]])
        self.assertEqual((bounds["width"], bounds["height"]), (30, 15))

    def test_opacity_visibility_stroke_uniform_and_shadow_are_typed(self):
        shadow = {"color": "rgba(0,0,0,.3)", "blur": 8, "offsetX": 2, "offsetY": 4, "affectStroke": False, "nonScaling": False}
        content = {"objects": [{"type": "Rect", "semanticId": "a", "opacity": 0.5, "visible": False, "strokeUniform": True, "shadow": shadow}]}
        [rect] = dm.from_fabric(content)["objects"]
        self.assertEqual((rect["opacity"], rect["visible"], rect["strokeUniform"]), (0.5, False, True))
        self.assertEqual(rect["shadow"], {"color": "rgba(0,0,0,.3)", "blur": 8, "x": 2, "y": 4, "extras": {"affectStroke": False, "nonScaling": False}})

    def test_malformed_placement_is_kept_verbatim_as_unknown(self):
        content = {"objects": [{"type": "Textbox", "text": "x", "top": "300", "left": 5}, {"type": "Rect", "angle": "turn"}, {"type": "Path", "isInk": True, "path": [["A", 1, 1, 0, 0, 0, 5, 5]]}]}
        doc = dm.from_fabric(content)
        self.assertEqual([obj["type"] for obj in doc["objects"]], ["unknown"] * 3)
        self.assertEqual([obj["raw"] for obj in doc["objects"]], content["objects"])

    def test_a_trailing_newline_does_not_make_a_colour_look_like_hex_with_alpha(self):
        content = {"objects": [{"type": "Path", "isInk": True, "path": [["M", 0, 0]], "stroke": "#20201e55\n", "semanticId": "a"}]}
        [ink] = dm.from_fabric(content)["objects"]
        self.assertEqual(ink["color"], "#20201e55\n")
        self.assertNotIn("alpha", ink)


class JavaScriptParityTests(unittest.TestCase):
    """The JS build is the reference: same model, same validation messages, on every fixture."""

    def setUp(self):
        if not HAS_NODE:
            self.skipTest("node is not installed")

    def test_python_and_javascript_build_the_same_model_from_every_fixture(self):
        self.assertEqual(set(JS_DUMP["fixtures"]), set(BY_NAME))
        for name, js in JS_DUMP["fixtures"].items():
            with self.subTest(name):
                self.assertTrue(approx_equal(model_of(name), js["model"]))

    def test_validation_gives_the_same_answers_and_messages(self):
        for name, js in JS_DUMP["fixtures"].items():
            doc = model_of(name)
            with self.subTest(name):
                self.assertEqual(dm.validate_document(doc), js["validation"])
                self.assertEqual(dm.validate_document(doc, require_ids=False), js["validationWithoutIds"])

    def test_invalid_documents_get_identical_errors_in_both(self):
        invalid = json.loads((ROOT / "tests" / "fixtures" / "invalid-documents.json").read_text())
        self.assertEqual([entry["name"] for entry in invalid], [entry["name"] for entry in JS_DUMP["invalid"]])
        for entry, js in zip(invalid, JS_DUMP["invalid"]):
            with self.subTest(entry["name"]):
                document = entry["document"]
                self.assertEqual(dm.validate_document(document), js["validation"])
                self.assertEqual(dm.validate_document(document, require_ids=False, strict=False), js["structural"])


if __name__ == "__main__":
    unittest.main()
