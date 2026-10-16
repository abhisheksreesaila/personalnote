import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

PROBE = """
import ssl, sys
sys.path.insert(0, sys.argv[1])
bare = ssl.create_default_context().cert_store_stats()["x509_ca"]
import download_tls
context = download_tls.https_context()
print(bare, context.cert_store_stats()["x509_ca"], context.verify_mode == ssl.CERT_REQUIRED, context.check_hostname)
"""


class DownloadTlsTest(unittest.TestCase):
    def test_trusts_certificates_on_a_machine_without_any(self):
        # The Mac app's OpenSSL points at a python.org folder the user's Mac does not have: no system certificates.
        with tempfile.TemporaryDirectory() as empty:
            cafile = Path(empty) / "none.pem"
            cafile.write_text("")
            env = {**os.environ, "SSL_CERT_FILE": str(cafile), "SSL_CERT_DIR": empty}
            out = subprocess.run([sys.executable, "-I", "-c", PROBE, str(ROOT)], env=env, capture_output=True, text=True, check=True)
        bare, ours, required, hostname = out.stdout.split()
        self.assertEqual(bare, "0")  # the failure as it happens on the Mac
        self.assertGreater(int(ours), 50)
        self.assertEqual((required, hostname), ("True", "True"))

    def test_both_runtimes_download_with_it(self):
        import download_tls
        import search_runtime
        import voice_runtime

        self.assertIs(voice_runtime.VoiceRuntime.__dataclass_fields__["opener"].default, download_tls.open_url)
        self.assertIs(search_runtime.SearchRuntime.__dataclass_fields__["opener"].default, download_tls.open_url)


if __name__ == "__main__":
    unittest.main()
