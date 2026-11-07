"""Loopback-only HTTP adapter for MVP intake; TLS belongs to the reverse proxy."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mvp_intake import receive
from webhook_ingress import MAX_BODY

PATH = "/agent-github-flow/webhook"


def make_server(store, secret, registry, *, port=0, wake_admission=None, status_repositories=None):
    """Create a server but do not start it or load any secret from disk."""
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            # Request paths, metadata and bodies may contain private context.
            pass

        def respond(self, status):
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self):
            lengths = self.headers.get_all("Content-Length", [])
            signatures = self.headers.get_all("X-Hub-Signature-256", [])
            events = self.headers.get_all("X-GitHub-Event", [])
            if (len(lengths) != 1 or len(lengths[0]) > 10 or not lengths[0].isascii() or not lengths[0].isdigit()
                    or len(signatures) != 1 or len(events) != 1
                    or self.headers.get_all("Transfer-Encoding", [])):
                return self.respond(400)
            length = int(lengths[0])
            if not 0 < length <= MAX_BODY:
                return self.respond(413)
            self.connection.settimeout(10)
            try:
                body = self.rfile.read(length)
            except (OSError, TimeoutError):
                return self.respond(400)
            if len(body) != length:
                return self.respond(400)
            if self.path != PATH:
                return self.respond(404)
            result = receive(store, secret, registry, events[0], signatures[0], body,
                             wake_admission=wake_admission, status_repositories=status_repositories)
            statuses = {"accepted": 202, "ignored": 204, "invalid": 400,
                        "bad_signature": 401, "unknown_project": 403,
                        "unsupported": 400, "configuration_error": 503,
                        "storage_unavailable": 503, "attention": 503}
            return self.respond(statuses.get(result, 503))

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)
