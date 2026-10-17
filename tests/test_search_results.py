"""What the omnibar's rows and preview are given (F-101): the snippet, the notebook and the times for an ordinary note, and for a secure note only
what the notes list already shows (its title and icon), never a snippet or preview text."""
import tempfile
import unittest
from pathlib import Path

from services import NoteService
from tests.test_secure_notes import FakeMac


class SearchResultsTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.service = NoteService(Path(self.folder.name) / "p.db", secure_platform=FakeMac(), scrypt_cost=2**4)

    def tearDown(self):
        self.folder.cleanup()

    def page(self, title, words):
        note = self.service.create_note({"title": title, "noteType": "page"})
        saved = self.service.update_note(note["id"], {"title": title, "revision": note["revision"], "content": {"markdown": words, "ink": {"marks": [], "drawings": []}}})
        return note, saved

    def test_an_ordinary_note_comes_with_its_snippet_its_times_and_its_icon(self):
        note, _ = self.page("Lisbon trip", "Flights and hotels for the spring trip to Lisbon")
        (hit,) = self.service.search("spring")
        self.assertEqual((hit["title"], hit["notebookName"], hit["secure"]), ("Lisbon trip", "Inbox", False))
        self.assertIn("spring", hit["excerpt"])
        self.assertRegex(hit["updatedAt"], r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$")
        (row,) = [item for item in self.service.list_notes() if item["id"] == note["id"]]
        self.assertEqual((row["icon"]["emoji"], row["createdAt"] <= row["updatedAt"]), ("✈️", True))

    def test_a_secure_note_has_no_snippet_and_no_preview_text(self):
        note, saved = self.page("Card numbers", "ZEBRA-4111 the secret words")
        self.service.mark_secure(note["id"], revision=saved["revision"])
        (hit,) = self.service.search("numbers")
        self.assertEqual((hit["title"], hit["secure"], hit["excerpt"]), ("Card numbers", True, ""))
        self.assertEqual(self.service.search("ZEBRA"), [])
        resource = self.service.get_note(note["id"])["resourceId"]
        card = self.service.note_links([resource])[resource]
        self.assertEqual((card["excerpt"], card["secure"]), ("", True))
        (row,) = [item for item in self.service.list_notes() if item["id"] == note["id"]]
        self.assertEqual(set(row), {"id", "resourceId", "revision", "noteType", "title", "notebookId", "createdAt", "updatedAt", "secure", "icon"})


if __name__ == "__main__":
    unittest.main()
