"""A step's directory as Cronplane prepares it, and a local HTTP server."""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from cronplane_actions import Action, JsonValue


@dataclass
class Step:
    """The files and variables Cronplane gives a step using an action."""

    dir: Path
    env: dict[str, str] = field(default_factory=dict[str, str])

    def with_inputs(self, values: Mapping[str, JsonValue]) -> Step:
        (self.dir / "with.json").write_text(json.dumps(values))
        return self

    def action(self) -> Action:
        return Action.from_environment(self.env)

    @property
    def output(self) -> JsonValue:
        return json.loads((self.dir / "output.json").read_text())

    @property
    def masked(self) -> list[str]:
        return (self.dir / "mask").read_text().splitlines()


@pytest.fixture
def step(tmp_path: Path) -> Step:
    (tmp_path / "with.json").write_text("{}")
    (tmp_path / "inputs.json").write_text('{"build": {"tag": "v1"}}')
    env = {
        "CRONPLANE_WITH": str(tmp_path / "with.json"),
        "CRONPLANE_OUTPUT": str(tmp_path / "output.json"),
        "CRONPLANE_MASK": str(tmp_path / "mask"),
        "CRONPLANE_INPUTS": str(tmp_path / "inputs.json"),
        "CRONPLANE_VERSION": "0.1.0",
    }
    return Step(tmp_path, env)


@dataclass
class Seen:
    """A request the local server received."""

    method: str
    path: str
    headers: dict[str, str]
    body: bytes


@dataclass
class Server:
    """Answers each path with what `routes` gives: status, headers, body."""

    port: int
    routes: dict[str, tuple[int, dict[str, str], bytes]]
    seen: list[Seen]

    def url(self, path: str, host: str = "127.0.0.1") -> str:
        return f"http://{host}:{self.port}{path}"


@pytest.fixture
def server() -> Iterator[Server]:
    routes: dict[str, tuple[int, dict[str, str], bytes]] = {}
    seen: list[Seen] = []

    class Handler(BaseHTTPRequestHandler):
        def answer(self) -> None:
            length = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(length)
            seen.append(Seen(self.command, self.path, dict(self.headers.items()), body))
            status, headers, content = routes.get(self.path, (404, {}, b"not found"))
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            self.send_header("content-length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)

        do_GET = do_POST = do_HEAD = answer

        def log_message(self, format: str, *args: object) -> None:
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield Server(httpd.server_address[1], routes, seen)
    httpd.shutdown()
    httpd.server_close()
