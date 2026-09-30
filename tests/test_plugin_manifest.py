import unittest

from plugin_manifest import PluginManifestError, parse_plugin_manifest


class PluginManifestTests(unittest.TestCase):
    def test_accepts_declared_supported_capabilities(self):
        manifest = parse_plugin_manifest({
            "id": "example.capture",
            "name": "Example Capture",
            "version": "1.0.0",
            "hostApi": 1,
            "capabilities": ["commands", "storage"],
        })
        self.assertEqual(manifest.as_dict()["capabilities"], ["commands", "storage"])

    def test_rejects_unknown_capabilities_and_host_versions(self):
        with self.assertRaisesRegex(PluginManifestError, "unsupported capabilities"):
            parse_plugin_manifest({
                "id": "example.bad", "name": "Bad", "version": "1", "hostApi": 1,
                "capabilities": ["filesystem"],
            })
        with self.assertRaisesRegex(PluginManifestError, "unsupported host API"):
            parse_plugin_manifest({
                "id": "example.old", "name": "Old", "version": "1", "hostApi": 0,
            })


if __name__ == "__main__":
    unittest.main()
