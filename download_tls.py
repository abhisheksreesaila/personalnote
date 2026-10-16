"""HTTPS for the optional downloads (voice and search), with certificates that travel with the app.

The Mac app bundles python.org's OpenSSL, which looks for certificates under
/Library/Frameworks/Python.framework/... on the user's Mac; that folder is absent unless they installed python.org
Python themselves, so every download failed its certificate check. The system's certificates are still loaded where
they exist; certifi's bundle is added on top so verification never depends on them.
"""

from __future__ import annotations

import ssl
from functools import lru_cache
from urllib.request import urlopen

import certifi


@lru_cache(maxsize=1)
def https_context() -> ssl.SSLContext:
    context = ssl.create_default_context()
    context.load_verify_locations(cafile=certifi.where())
    return context


def open_url(request, timeout: float = 30):
    """`urlopen` with the bundled certificates; certificate and hostname checks stay on."""
    return urlopen(request, timeout=timeout, context=https_context())
