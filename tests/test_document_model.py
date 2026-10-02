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
PLACEMENT = {"left", "top", "width", "height", "angle", "scaleX", "scaleY", "flipX", "flipY", "skewX", "skewY", "originX", "originY", "path", "inkPoints"}

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


def without_placement(value):
    """Fabric JSON minus the properties the round trip re-derives (where things are); everything else must match exactly."""
    if isinstance(value, list):
        return [without_placement(item) for item in value]
    if isinstance(value, dict):
        return {key: without_placement(item) for key, item in value.items() if key not in PLACEMENT}
    return value


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


class RoundTripTests(unittest.TestCase):
    def test_every_fixture_comes_back_with_everything_but_placement_unchanged(self):
        self.assertGreaterEqual(len(FIXTURES), 10)
        for fixture in FIXTURES:
            with self.subTest(fixture["name"]):
                doc = dm.from_fabric(fixture["content"], fixture["pageState"])
                back = dm.to_fabric(doc)
                self.assertEqual(without_placement(back), without_placement(fixture["content"]))
                self.assertEqual(len(back["objects"]), len(fixture["content"]["objects"]))
                self.assertEqual(dm.page_state_of(doc), fixture["pageState"])

    def test_converting_twice_changes_nothing_more(self):
        for fixture in FIXTURES:
            with self.subTest(fixture["name"]):
                once = dm.to_fabric(dm.from_fabric(fixture["content"], fixture["pageState"]))
                twice = dm.to_fabric(dm.from_fabric(once, fixture["pageState"]))
                self.assertTrue(approx_equal(once, twice, 1e-6))

    def test_the_round_trip_survives_json(self):
        for fixture in FIXTURES:
            with self.subTest(fixture["name"]):
                doc = json.loads(json.dumps(dm.from_fabric(fixture["content"], fixture["pageState"])))
                self.assertEqual(without_placement(dm.to_fabric(doc)), without_placement(fixture["content"]))

    def test_explicit_null_properties_are_not_confused_with_absent_ones(self):
        content = {"objects": [{"type": "Rect", "stroke": None, "fill": None, "rx": 0, "semanticId": "a"}, {"type": "Rect", "semanticId": "b"}]}
        self.assertEqual(without_placement(dm.to_fabric(dm.from_fabric(content))), without_placement(content))

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

    def test_colours_that_are_not_hex_with_alpha_are_not_rewritten(self):
        for stroke in ("#20201E55", "rgba(1,2,3,0.5)", "red", "#223", "#2020aa"):
            content = {"objects": [{"type": "Path", "isInk": True, "path": [["M", 0, 0]], "stroke": stroke, "semanticId": "a"}]}
            self.assertEqual(without_placement(dm.to_fabric(dm.from_fabric(content))), without_placement(content), stroke)

    def test_media_library_pictures_need_a_resolver(self):
        doc = model_of("app-objects")
        data_url = of_type(doc, "image")[0]["mediaRef"]["dataUrl"]
        stored = copy.deepcopy(doc)
        of_type(stored, "image")[0]["mediaRef"] = {"kind": "media", "id": "med_123"}
        self.assertTrue(dm.validate_document(stored)["ok"])
        with self.assertRaisesRegex(dm.DocumentError, "med_123"):
            dm.to_fabric(stored)
        resolved = dm.to_fabric(stored, resolve_media=lambda ref: data_url if ref["id"] == "med_123" else None)
        self.assertEqual(without_placement(resolved), without_placement(BY_NAME["app-objects"]["content"]))

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
            'objects[7].type: unknown object type "sparkle"',
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

    def test_plain_text_has_the_same_blocks_as_note_text_on_every_fixture(self):
        for fixture in FIXTURES:
            with self.subTest(fixture["name"]):
                doc = dm.from_fabric(fixture["content"], fixture["pageState"])
                old = [item["text"].strip() for item in fixture["content"]["objects"] if isinstance(item, dict) and isinstance(item.get("text"), str) and item["text"].strip()]
                self.assertEqual(sorted(dm.plain_text_blocks(doc)), sorted(old))

    def test_plain_text_keeps_note_texts_order_when_every_text_block_shares_an_origin(self):
        for name in ("app-text", "cli-created", "benchmark-600", "ink-dots", "edge-transforms"):
            with self.subTest(name):
                doc = model_of(name)
                self.assertEqual(dm.plain_text(doc), canvas_plain_text(BY_NAME[name]["content"]))

    def test_plain_text_reads_by_top_edge_where_note_text_read_by_origin_point(self):
        # app-objects: a sticky (200 tall) and a text block are both centred on the same line. The sticky's top edge is higher.
        doc = model_of("app-objects")
        old = canvas_plain_text(BY_NAME["app-objects"]["content"]).split("\n\n")
        new = dm.plain_text(doc).split("\n\n")
        self.assertEqual(old[0], "Meeting notes: ship the export")
        self.assertEqual(new[0], "Purple note")
        self.assertEqual(sorted(new), sorted(old))

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

    def test_a_q_curve_is_measured_the_way_fabric_measures_it(self):
        bounds = dm._path_bounds([["M", 10, 10], ["Q", 20, 30, 40, 10]])
        self.assertEqual((bounds["width"], bounds["height"]), (30, 15))

    def test_opacity_visibility_stroke_uniform_and_shadow_are_typed(self):
        shadow = {"color": "rgba(0,0,0,.3)", "blur": 8, "offsetX": 2, "offsetY": 4, "affectStroke": False, "nonScaling": False}
        content = {"objects": [{"type": "Rect", "semanticId": "a", "opacity": 0.5, "visible": False, "strokeUniform": True, "shadow": shadow}]}
        [rect] = dm.from_fabric(content)["objects"]
        self.assertEqual((rect["opacity"], rect["visible"], rect["strokeUniform"]), (0.5, False, True))
        self.assertEqual(rect["shadow"], {"color": "rgba(0,0,0,.3)", "blur": 8, "x": 2, "y": 4, "extras": {"affectStroke": False, "nonScaling": False}})
        self.assertEqual(dm.to_fabric(dm.from_fabric(content))["objects"][0]["shadow"], shadow)

    def test_malformed_placement_is_kept_verbatim_as_unknown(self):
        content = {"objects": [{"type": "Textbox", "text": "x", "top": "300", "left": 5}, {"type": "Rect", "angle": "turn"}, {"type": "Path", "isInk": True, "path": [["A", 1, 1, 0, 0, 0, 5, 5]]}]}
        doc = dm.from_fabric(content)
        self.assertEqual([obj["type"] for obj in doc["objects"]], ["unknown"] * 3)
        self.assertEqual(dm.to_fabric(doc), content)

    def test_a_trailing_newline_does_not_make_a_colour_look_like_hex_with_alpha(self):
        content = {"objects": [{"type": "Path", "isInk": True, "path": [["M", 0, 0]], "stroke": "#20201e55\n", "semanticId": "a"}]}
        [ink] = dm.from_fabric(content)["objects"]
        self.assertEqual(ink["color"], "#20201e55\n")
        self.assertNotIn("alpha", ink)


class JavaScriptParityTests(unittest.TestCase):
    """The JS build is the reference: same model, same validation messages, same Fabric output, on every fixture."""

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

    def test_to_fabric_gives_the_same_output(self):
        for name, js in JS_DUMP["fixtures"].items():
            with self.subTest(name):
                self.assertTrue(approx_equal(dm.to_fabric(model_of(name)), js["fabric"]))

    def test_invalid_documents_get_identical_errors_in_both(self):
        invalid = json.loads((ROOT / "tests" / "fixtures" / "invalid-documents.json").read_text())
        self.assertEqual([entry["name"] for entry in invalid], [entry["name"] for entry in JS_DUMP["invalid"]])
        for entry, js in zip(invalid, JS_DUMP["invalid"]):
            with self.subTest(entry["name"]):
                document = entry["document"]
                self.assertEqual(dm.validate_document(document), js["validation"])
                self.assertEqual(dm.validate_document(document, require_ids=False, strict=False), js["structural"])
                try:
                    dm.to_fabric(document)
                    error = None
                except dm.DocumentError as exc:
                    error = str(exc)
                self.assertEqual(error, js["fabricError"])


if __name__ == "__main__":
    unittest.main()
