import io
import unittest
from unittest.mock import MagicMock, patch

from startup import check_existing_server, probe_host


class StartupTests(unittest.TestCase):
    def test_wildcard_host_is_probed_locally(self):
        self.assertEqual(probe_host("0.0.0.0"), "127.0.0.1")

    @patch("startup.socket.create_connection", side_effect=ConnectionRefusedError)
    def test_free_port_allows_startup(self, _create_connection):
        self.assertIsNone(check_existing_server("127.0.0.1", 3137))

    @patch("startup.urlopen")
    @patch("startup.socket.create_connection")
    def test_personal_note_listener_returns_existing_url(self, create_connection, open_url):
        create_connection.return_value = MagicMock()
        response = MagicMock()
        response.__enter__.return_value = io.BytesIO(
            b'{"app":"personal-note","backend":"fasthtml"}'
        )
        response.__exit__.return_value = False
        open_url.return_value = response

        self.assertEqual(
            check_existing_server("127.0.0.1", 3137),
            "http://127.0.0.1:3137",
        )

    @patch("startup.urlopen")
    @patch("startup.socket.create_connection")
    def test_unrelated_listener_fails_clearly(self, create_connection, open_url):
        create_connection.return_value = MagicMock()
        response = MagicMock()
        response.__enter__.return_value = io.BytesIO(b'{"status":"ok"}')
        response.__exit__.return_value = False
        open_url.return_value = response

        with self.assertRaisesRegex(RuntimeError, "another application"):
            check_existing_server("127.0.0.1", 3137)


if __name__ == "__main__":
    unittest.main()