import json
import socket
from urllib.error import URLError
from urllib.request import urlopen


def probe_host(host: str) -> str:
    return "127.0.0.1" if host in {"0.0.0.0", "::"} else host


def check_existing_server(host: str, port: int) -> str | None:
    target_host = probe_host(host)
    try:
        connection = socket.create_connection((target_host, port), timeout=0.35)
    except OSError:
        return None
    else:
        connection.close()

    base_url = f"http://{target_host}:{port}"
    try:
        with urlopen(f"{base_url}/health", timeout=0.5) as response:
            payload = json.load(response)
    except (OSError, URLError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError(
            f"Port {port} is already in use by another process. "
            "Stop it or set PORT to a different value."
        ) from error

    if payload.get("app") != "personal-note" or payload.get("backend") != "fasthtml":
        raise RuntimeError(
            f"Port {port} is already in use by another application. "
            "Stop it or set PORT to a different value."
        )
    return base_url