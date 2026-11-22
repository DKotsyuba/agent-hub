"""Smoke-test an extracted Linux release using an isolated Run Unix producer."""

from contextlib import closing
import fcntl
import http.client
import json
import os
from pathlib import Path
import pty
import re
import select
import socket
from socketserver import StreamRequestHandler, ThreadingUnixStreamServer
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import struct
from subprocess import Popen, TimeoutExpired, check_output
import sys
from tempfile import TemporaryDirectory
import termios
from threading import Thread
import time


class RunFixture(StreamRequestHandler):
    """Provide a finite JSON-RPC inventory through the native Run protocol."""

    def handle(self):
        request = json.loads(self.rfile.readline(65536))
        now = int(time.time())
        rows = [{
            "agent_id": "release-fixture", "sequence": 1, "name": "Release fixture",
            "task_summary": "Release smoke", "status": "running", "model": "fixture",
            "workdir": "/fixture/project", "elapsed_seconds": 12, "silence_seconds": 2,
            "observed_at": now, "last_progress_at": now - 2, "finished_at": None,
            "answer_available": False, "answer_sha256": None,
        }]
        result = {
            "list_agents": {"items": rows, "offset": 0, "limit": 200, "total": 1,
                            "next_offset": None, "complete": True, "revision": 1,
                            "message_revision": 1, "observed_at": now},
            "ping": {"ok": True},
            "tools": [],
        }.get(request["method"])
        self.wfile.write((json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}) + "\n").encode())


class UnixHttp(http.client.HTTPConnection):
    """Send fixture traffic to the extracted server's Unix listener."""

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.unix_path)


class Proxy(BaseHTTPRequestHandler):
    """Expose the same Unix listener on an isolated loopback origin for the smoke clients."""

    def do_GET(self):
        try:
            self.forward()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def forward(self):
        """Stream SSE frames or forward a finite response from the Unix socket."""
        with closing(UnixHttp("localhost", timeout=20)) as connection:
            connection.unix_path = self.server.unix_path
            connection.request("GET", self.path)
            with connection.getresponse() as response:
                self.send_response(response.status)
                self.send_header("Content-Type", response.getheader("Content-Type", "application/octet-stream"))
                stream = self.path.startswith("/api/v1/events?")
                if not stream:
                    payload = response.read()
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                self.end_headers()
                try:
                    while line := response.readline():
                        self.wfile.write(line)
                        self.wfile.flush()
                except OSError:
                    pass

    def log_message(self, *_args):
        """Keep probe output bounded."""


def stop(process):
    """Terminate an owned process and reap it even if graceful shutdown times out."""
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except TimeoutExpired:
            process.kill()
            process.wait()


def terminal_smoke(binary, port, env, cwd):
    """Wait for the fixture in a real PTY and quit via the normal key binding."""
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    with Popen([binary, "--server", f"http://127.0.0.1:{port}"], cwd=cwd, env=env,
               stdin=slave, stdout=slave, stderr=slave) as terminal:
        os.close(slave)
        try:
            output = b""
            opened_sessions = False
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and not any(label in output for label in (b"Release fixture", b"release-fixture")):
                if select.select([master], [], [], 0.2)[0]:
                    try:
                        output += os.read(master, 65536)
                        if not opened_sessions and b"1 sessions" in output:
                            os.write(master, b"1")
                            opened_sessions = True
                    except OSError as error:
                        raise AssertionError(f"Terminal exited before rendering: {output[-4000:]!r}") from error
            assert any(label in output for label in (b"Release fixture", b"release-fixture")), output[-4000:]
            os.write(master, b"q")
            deadline = time.monotonic() + 5
            while terminal.poll() is None and time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        os.read(master, 65536)
                    except OSError:
                        break
            assert terminal.wait(timeout=2) == 0
        finally:
            stop(terminal)
            os.close(master)


def smoke(release, browser_command):
    """Check Unix HTTP health, data, static assets, SSE and the packaged TUI."""
    with TemporaryDirectory(prefix="eh-", dir=os.environ["TMPDIR"]) as directory:
        root = Path(directory)
        http_dir = root / "http"
        http_dir.mkdir(mode=0o750)
        http_dir.chmod(0o750)
        unix_path = http_dir / "hub.sock"
        run_path = root / "run.sock"
        config = root / "connections.json"
        config.write_text(json.dumps({
            "schema_version": 1, "run": {"socket": str(run_path)},
            "pool": {"socket": str(root / "pool.sock"), "server_uid": os.getuid()},
            "quota": {"socket": str(root / "quota.sock"), "server_uid": os.getuid()},
        }))
        env = {key: value for key, value in os.environ.items() if not key.startswith("AGENT_HUB_") or key in ("AGENT_HUB_CHROME", "AGENT_HUB_CHROMEDRIVER")}
        env.update(AGENT_HUB_CONFIG=str(config), HOME=directory, XDG_CONFIG_HOME=directory,
                   TERM="xterm-256color", TMPDIR=directory, TMP=directory, TEMP=directory)
        with ThreadingUnixStreamServer(str(run_path), RunFixture) as fixture, ThreadingHTTPServer(("127.0.0.1", 0), Proxy) as proxy:
            run_path.chmod(0o600)
            proxy.unix_path = str(unix_path)
            for service in (fixture, proxy):
                Thread(target=service.serve_forever, daemon=True).start()
            try:
                with Popen([release / "bin/hub-server", "--unix", unix_path], cwd=root, env=env) as server:
                    try:
                        deadline = time.monotonic() + 10
                        while not unix_path.exists() and server.poll() is None and time.monotonic() < deadline:
                            time.sleep(0.02)
                        assert unix_path.exists(), "Extracted hub-server did not bind"
                        def get(path):
                            """Read a single finite response over the socket."""
                            return check_output(["curl", "--fail", "--silent", "--show-error", "--retry", "3",
                                                 "--retry-connrefused", "--max-time", "8",
                                                 "--unix-socket", str(unix_path), "http://localhost" + path])
                        health = json.loads(get("/api/v1/health"))
                        assert health["ready"] and health["release"] == release.name.removeprefix("agent-hub-").removesuffix("-linux-x86_64")
                        assert json.loads(get("/api/v1/sessions"))["data"]["items"][0]["id"] == "release-fixture"
                        index = get("/")
                        assert get("/sessions/release-fixture/details") == index
                        assets = re.findall(rb"""["'](/assets/[\w.-]+\.(?:js|css))["']""", index)
                        assert {asset.rsplit(b".", 1)[1] for asset in assets} == {b"js", b"css"}
                        for asset in assets:
                            assert get(asset.decode())
                        with closing(UnixHttp("localhost", timeout=8)) as connection:
                            connection.unix_path = str(unix_path)
                            connection.request("GET", "/api/v1/events?topic=sessions&interval=1")
                            with connection.getresponse() as stream:
                                assert stream.status == 200 and stream.readline().strip() == b"event: ready"
                                assert b'"sessions"' in stream.readline()
                        terminal_smoke(release / "bin/agent-hub", proxy.server_port, env, root)
                        if browser_command:
                            print(check_output([*browser_command, f"http://127.0.0.1:{proxy.server_port}"], env=env, timeout=180).decode(), end="")
                    finally:
                        stop(server)
            finally:
                for service in (proxy, fixture):
                    service.shutdown()
    print("Extracted archive passed Unix health, fixture sessions, web deep link, SSE and TUI PTY smoke.")


if __name__ == "__main__":
    smoke(Path(sys.argv[1]).resolve(), sys.argv[2:])
