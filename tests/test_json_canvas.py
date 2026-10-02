import copy
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import document_model as dm
import json_canvas as jc
from media_store import MediaStore

ROOT = Path(__file__).resolve().parent.parent
FIXTURE_DIR = ROOT / "tests" / "fixtures" / "documents"

HAS_NODE = shutil.which("node") is not None
if not HAS_NODE and os.environ.get("CI"):
    raise RuntimeError("node is required on CI: the JSON Canvas parity test needs the JS build")
JS_DUMP = (
    json.loads(subprocess.run(["node", str(ROOT / "scripts" / "dump-document-models.mjs")], capture_output=True, text=True, check=True, cwd=ROOT).stdout)
    if HAS_NODE
    else None
)
FIXTURES = JS_DUMP["fixtures"] if JS_DUMP else {
    path.stem: {"content": json.loads(path.read_text())["content"], "pageState": json.loads(path.read_text())["pageState"]}
    for path in sorted(FIXTURE_DIR.glob("*.json"))
}


def approx_equal(a, b, tolerance=1e-9):
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= tolerance
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(approx_equal(a[key], b[key], tolerance) for key in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(approx_equal(x, y, tolerance) for x, y in zip(a, b))
    return a == b


def model_of(name):
    fixture = FIXTURES[name]
    return dm.from_fabric(fixture["content"], fixture["pageState"])


class JsonCanvasTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp(dir=os.environ.get("TMPDIR"))
        self.addCleanup(shutil.rmtree, self.folder, True)
        self.store = MediaStore(Path(self.folder) / "media")

    def test_every_fixture_round_trips_and_validates(self):
        self.assertGreaterEqual(len(FIXTURES), 10)
        for name in FIXTURES:
            with self.subTest(name):
                doc = model_of(name)
                canvas = json.loads(json.dumps(jc.to_json_canvas(doc)))
                report = jc.validate_json_canvas(canvas)
                self.assertTrue(report["ok"], report["errors"][:3])
                self.assertEqual(jc.from_json_canvas(canvas), doc)

    def test_with_a_store_pictures_are_files_and_the_round_trip_holds(self):
        for name in FIXTURES:
            with self.subTest(name):
                doc = model_of(name)
                canvas = jc.to_json_canvas(doc, media=self.store)
                self.assertTrue(jc.validate_json_canvas(canvas)["ok"])
                for node in canvas["nodes"]:
                    if node["type"] == "file":
                        self.assertRegex(node["file"], r"^media/[0-9a-f]{64}\.(png|jpg|webp|gif|svg)$")
                        self.assertTrue((Path(self.folder) / node["file"]).is_file())
                back = jc.from_json_canvas(json.loads(json.dumps(canvas)))

                def strip(document):
                    return {**document, "objects": [{**o, "mediaRef": None} if o["type"] == "image" else o for o in document["objects"]]}

                self.assertEqual(strip(back), strip(doc))

    @unittest.skipUnless(HAS_NODE, "node is needed for the JS build")
    def test_python_and_js_write_the_same_canvas(self):
        for name, entry in FIXTURES.items():
            with self.subTest(name):
                doc = dm.from_fabric(entry["content"], entry["pageState"])
                self.assertTrue(approx_equal(jc.to_json_canvas(doc), entry["canvas"]), "inline form")
                self.assertTrue(approx_equal(jc.to_json_canvas(doc, derived="omit"), entry["canvasOmit"]), "omit form")
                self.assertTrue(approx_equal(jc.to_json_canvas(doc, media=self.store), entry["canvasStored"]), "stored form (same file names)")

    @unittest.skipUnless(HAS_NODE, "node is needed for the JS build")
    def test_python_reads_what_js_wrote(self):
        for name, entry in FIXTURES.items():
            with self.subTest(name):
                self.assertTrue(approx_equal(jc.from_json_canvas(entry["canvas"]), entry["model"]))

    def test_edits_by_another_app_win_and_foreign_canvases_open(self):
        doc = model_of("app-all-tools")
        canvas = json.loads(json.dumps(jc.to_json_canvas(doc)))
        text = next(n for n in canvas["nodes"] if n["type"] == "text" and "color" not in n)
        sticky = next(n for n in canvas["nodes"] if "color" in n)
        text["text"], text["x"], sticky["color"] = "Edited", text["x"] + 40, "4"
        canvas["edges"][0].update({"toEnd": "none", "fromEnd": "arrow"})
        back = jc.from_json_canvas(canvas)
        edited = next(o for o in back["objects"] if o["id"] == text["id"])
        self.assertEqual((edited["content"], edited["geometry"]["x"], edited["geometry"]["rotation"]), ("Edited", text["x"], 0))
        self.assertEqual(next(o for o in back["objects"] if o["id"] == sticky["id"])["color"], "#44cf6e")
        self.assertEqual(next(o for o in back["objects"] if o["id"] == canvas["edges"][0]["id"])["arrowheads"], {"start": True, "end": False})

        foreign = {
            "nodes": [
                {"id": "a", "type": "text", "text": "# Heading", "x": -300, "y": -200, "width": 250, "height": 120},
                {"id": "b", "type": "text", "text": "red", "x": 100, "y": -200, "width": 250, "height": 120, "color": "1"},
                {"id": "c", "type": "file", "file": "attachments/pic.png", "x": 100, "y": 100, "width": 300, "height": 200},
                {"id": "d", "type": "file", "file": "docs/spec.pdf", "x": 0, "y": 400, "width": 300, "height": 100},
                {"id": "e", "type": "link", "url": "https://example.com", "x": 400, "y": 400, "width": 300, "height": 100},
                {"id": "f", "type": "group", "label": "Area", "x": -400, "y": -300, "width": 900, "height": 700},
            ],
            "edges": [{"id": "g", "fromNode": "a", "toNode": "b"}],
        }
        self.assertTrue(jc.validate_json_canvas(foreign)["ok"])
        opened = jc.from_json_canvas(foreign)
        by_id = {o["id"]: o for o in opened["objects"]}
        self.assertEqual([by_id[k]["type"] for k in "abcdefg"], ["text", "sticky", "image", "text", "text", "shape", "connector"])
        self.assertTrue(all(o["type"] == "connector" or o["geometry"]["x"] >= 0 for o in opened["objects"]))
        self.assertTrue(jc.validate_json_canvas(jc.to_json_canvas(opened))["ok"])

    def test_odd_notes_survive(self):
        doc = dm.from_fabric({"objects": [
            {"type": "Textbox", "text": "a", "left": 10, "top": 10, "width": 100, "height": 30, "semanticId": "res_a"},
            {"type": "Connector", "fromId": "res_a", "toId": "res_gone", "semanticId": "res_c", "left": 0, "top": 0, "width": 5, "height": 5},
            {"type": "Group", "left": 300, "top": 300, "width": 200, "height": 100, "semanticId": "res_g", "objects": [{"type": "Textbox", "text": "in", "left": -50, "top": 0, "width": 80, "height": 20}]},
            {"type": "Weird", "left": 5, "top": 6, "foo": "bar", "text": "kept"},
        ]}, {"columns": 2, "rows": 2})
        canvas = json.loads(json.dumps(jc.to_json_canvas(doc)))
        self.assertTrue(jc.validate_json_canvas(canvas)["ok"])
        self.assertEqual(canvas["edges"], [])
        self.assertEqual(jc.from_json_canvas(canvas), doc)

    def test_reading_order_is_by_top_edge(self):
        doc = dm.from_fabric({"objects": [
            {"type": "Textbox", "text": "second", "left": 10, "top": 200, "width": 100, "height": 30, "originX": "left", "originY": "top"},
            {"type": "Textbox", "text": "first", "left": 400, "top": 20, "width": 100, "height": 30, "originX": "left", "originY": "top"},
        ]})
        self.assertEqual(jc.plain_text(jc.from_json_canvas(jc.to_json_canvas(doc))), "first\n\nsecond")

    def test_the_input_is_not_modified(self):
        doc = model_of("app-all-tools")
        before = copy.deepcopy(doc)
        jc.from_json_canvas(jc.to_json_canvas(doc))
        self.assertEqual(doc, before)


if __name__ == "__main__":
    unittest.main()
