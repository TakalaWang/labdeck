"""Test-only OAuth2 provider in NYCU's shape, a fake Discord (OAuth2 + webhook sink) and an SMTP sink. Never use outside e2e.

GET  /authorize?redirect_uri=&state=  HTML form (username + submit)
POST /login                           302 → redirect_uri?code=<username>&state=…
POST /token                           {"access_token": "tok-<code>", "token_type": "Bearer", "expires_in": 3600}
GET  /profile  (Bearer tok-<name>)    {"username": <name>, "email": "<name>@example.edu"}

GET  /discord/oauth2/authorize?client_id=&redirect_uri=&state=&scope=identify   HTML form (Discord name + Authorize)
POST /discord/oauth2/approve          302 → redirect_uri?code=dc-<name>&state=…
POST /discord/api/oauth2/token        client_secret_post; {"access_token": "dtok-<name>", …}
GET  /discord/api/users/@me (Bearer dtok-<name>)  {"id": <snowflake>, "username": <name>, "global_name": <Name>}

POST anything else (e.g. /discord)    204; recorded (JSON) and printed to stdout (docker compose logs mock-oauth)
SMTP :2525                            accepts any mail (no auth, no TLS) and records it
GET  /_sink                           {"webhooks": [{path, body}], "mails": [{from, to, subject, body}], "discord_users": {name: id}}
"""
import email
import email.policy
import html
import json
import socketserver
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

DISCORD_CLIENT = ("e2e-discord", "e2e-discord-secret")  # = run.sh's DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET
SINK = {"webhooks": [], "mails": [], "discord_users": {}}
LOCK = threading.Lock()


def snowflake(name):
    with LOCK:
        return SINK["discord_users"].setdefault(name, str(900000000000000000 + len(SINK["discord_users"])))


def form_page(title, action, hidden, field, button):
    inputs = "".join(f'<input type="hidden" name="{k}" value="{html.escape(v)}">' for k, v in hidden.items())
    return (f'<!doctype html><title>{title}</title><form method="post" action="{action}"><h1>{title}</h1>{inputs}'
            f'<input name="{field}" placeholder="{field}" autofocus><button>{button}</button></form>').encode()


class Handler(BaseHTTPRequestHandler):
    def send(self, code, body=b"", ctype="application/json", headers=()):
        self.send_response(code)
        if code != 204:
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, uri, **params):
        sep = "&" if "?" in uri else "?"
        return self.send(302, headers=[("Location", uri + sep + urlencode(params))])

    def do_GET(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        auth = self.headers.get("Authorization", "")
        if url.path == "/authorize":
            page = form_page("Mock SSO", "/login", {k: q.get(k, "") for k in ("redirect_uri", "state")}, "username", "Sign in")
            return self.send(200, page, "text/html; charset=utf-8")
        if url.path == "/profile":
            if not auth.startswith("Bearer tok-"):
                return self.send(401, b'{"error": "invalid_token"}')
            name = auth.removeprefix("Bearer tok-")
            return self.send(200, json.dumps({"username": name, "email": f"{name}@example.edu"}).encode())
        if url.path == "/discord/oauth2/authorize":
            if q.get("client_id") != DISCORD_CLIENT[0] or q.get("scope") != "identify" or q.get("response_type") != "code":
                return self.send(400, b'{"error": "invalid_request"}')
            page = form_page("Mock Discord", "/discord/oauth2/approve",
                             {k: q.get(k, "") for k in ("redirect_uri", "state")}, "discord_name", "Authorize")
            return self.send(200, page, "text/html; charset=utf-8")
        if url.path == "/discord/api/users/@me":
            if not auth.startswith("Bearer dtok-"):
                return self.send(401, b'{"message": "401: Unauthorized"}')
            name = auth.removeprefix("Bearer dtok-")
            return self.send(200, json.dumps({"id": snowflake(name), "username": name,
                                              "global_name": name.capitalize()}).encode())
        if url.path == "/_sink":
            with LOCK:
                return self.send(200, json.dumps(SINK).encode())
        self.send(404, b'{"error": "not_found"}')

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
        form = {k: v[0] for k, v in parse_qs(body).items()}
        if self.path == "/login":
            return self.redirect(form["redirect_uri"], code=form["username"], state=form.get("state", ""))
        if self.path == "/token":
            return self.send(200, json.dumps({"access_token": "tok-" + form["code"], "token_type": "Bearer",
                                              "expires_in": 3600}).encode())
        if self.path == "/discord/oauth2/approve":
            return self.redirect(form["redirect_uri"], code="dc-" + form["discord_name"], state=form.get("state", ""))
        if self.path == "/discord/api/oauth2/token":
            if ((form.get("client_id"), form.get("client_secret")) != DISCORD_CLIENT
                    or form.get("grant_type") != "authorization_code" or not form.get("code", "").startswith("dc-")
                    or not form.get("redirect_uri", "").endswith("/auth/discord/callback")):
                return self.send(401, b'{"error": "invalid_client"}')
            return self.send(200, json.dumps({"access_token": "dtok-" + form["code"][3:], "token_type": "Bearer",
                                              "expires_in": 604800, "scope": "identify"}).encode())
        print(f"WEBHOOK {self.path} {body}", flush=True)
        try:
            parsed = json.loads(body)
        except ValueError:
            parsed = body
        with LOCK:
            SINK["webhooks"].append({"path": self.path, "body": parsed})
        self.send(204)


class Smtp(socketserver.StreamRequestHandler):
    """Just enough SMTP for smtplib: EHLO, MAIL, RCPT, DATA, QUIT (no AUTH, no STARTTLS)."""

    def reply(self, line):
        self.wfile.write(line.encode() + b"\r\n")

    def handle(self):
        sender, rcpts = None, []
        self.reply("220 mock-smtp")
        while line := self.rfile.readline():
            cmd = line.decode(errors="replace").strip()
            verb = cmd[:4].upper()
            if verb in ("EHLO", "HELO"):
                self.reply("250 mock-smtp")
            elif verb == "MAIL":
                sender, rcpts = cmd.split(":", 1)[1].strip().split()[0].strip("<>"), []
                self.reply("250 OK")
            elif verb == "RCPT":
                rcpts.append(cmd.split(":", 1)[1].strip().strip("<>"))
                self.reply("250 OK")
            elif verb == "DATA":
                self.reply("354 go ahead")
                data = b""
                while (chunk := self.rfile.readline()) not in (b".\r\n", b""):
                    data += chunk[1:] if chunk.startswith(b"..") else chunk
                msg = email.message_from_bytes(data, policy=email.policy.default)
                with LOCK:
                    SINK["mails"].append({"from": sender, "to": rcpts, "subject": str(msg["Subject"]),
                                          "body": msg.get_body(("plain",)).get_content()})
                print(f"MAIL {rcpts} {msg['Subject']}", flush=True)
                self.reply("250 queued")
            elif verb == "QUIT":
                return self.reply("221 bye")
            else:  # RSET, NOOP, …
                self.reply("250 OK")


class SmtpServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


threading.Thread(target=SmtpServer(("0.0.0.0", 2525), Smtp).serve_forever, daemon=True).start()
ThreadingHTTPServer(("0.0.0.0", 9999), Handler).serve_forever()
