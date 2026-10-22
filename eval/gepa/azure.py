"""
A judge from another model family: Azure OpenAI, over its REST API with the standard library.

The v1 API (https://learn.microsoft.com/azure/ai-foundry/foundry-models/how-to/use-chat-completions): POST
`<endpoint>/openai/v1/chat/completions`, an `api-key` header, and the deployment name in the body's `model`; no
`api-version`. Credentials are read from the environment, or from `~/.config/eklavya-eval/azure.env` (KEY=VALUE lines, outside
the repository, never printed):

    AZURE_OPENAI_ENDPOINT        https://<resource>.openai.azure.com
    AZURE_OPENAI_KEY             (AZURE_OPENAI_API_KEY also works)
    AZURE_OPENAI_DEPLOYMENT      the deployment name of the judge model
    AZURE_OPENAI_INSECURE_TLS    "true" skips certificate checks for this client only, for a network that
                                 inspects TLS; the run prints a note when it is on

Self-check against a local fake server: `python3 eval/gepa/azure.py`.
"""
from __future__ import annotations

import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

ENV_FILE = Path.home() / ".config" / "eklavya-eval" / "azure.env"


def settings() -> dict | None:
    """The three required values, or None when this machine has no Azure judge configured."""
    env = dict(os.environ)
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip().strip("\"'"))
    got = {"endpoint": env.get("AZURE_OPENAI_ENDPOINT"), "api_key": env.get("AZURE_OPENAI_KEY") or env.get("AZURE_OPENAI_API_KEY"), "deployment": env.get("AZURE_OPENAI_DEPLOYMENT")}
    if not all(got.values()):
        return None
    insecure = env.get("AZURE_OPENAI_INSECURE_TLS", "").lower() == "true"
    if insecure:
        print("azure judge: TLS certificate checks are off for this client (AZURE_OPENAI_INSECURE_TLS)", file=sys.stderr)
    return {**got, "insecure_tls": insecure}


def ask(prompt: str, cfg: dict, timeout: float = 120) -> dict:
    """One chat completion. Returns {text, model, usage}; raises RuntimeError with the service's message on failure."""
    url = f"{cfg['endpoint'].rstrip('/')}/openai/v1/chat/completions"
    # No temperature and no token limit: the reasoning models reject the first and count their reasoning against the second.
    body = json.dumps({"model": cfg["deployment"], "messages": [{"role": "user", "content": prompt}]}).encode()
    ctx = ssl._create_unverified_context() if cfg.get("insecure_tls") else None
    req = urllib.request.Request(url, data=body, headers={"api-key": cfg["api_key"], "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as res:
            out = json.loads(res.read())
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"azure {err.code}: {err.read()[:200].decode(errors='replace')}") from err
    except (urllib.error.URLError, TimeoutError) as err:
        raise RuntimeError(f"azure unreachable: {err}") from err
    return {"text": out["choices"][0]["message"]["content"] or "", "model": out.get("model", cfg["deployment"]), "usage": out.get("usage", {})}


if __name__ == "__main__":
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    seen: dict = {}

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            seen.update(path=self.path, key=self.headers.get("api-key"), body=json.loads(self.rfile.read(int(self.headers["content-length"]))))
            code = 429 if "fail" in seen["body"]["messages"][0]["content"] else 200
            self.send_response(code)
            self.end_headers()
            self.wfile.write(json.dumps({"model": "gpt-test-2026", "choices": [{"message": {"content": "{\"ok\": true}"}}], "usage": {"prompt_tokens": 3}}).encode())

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    cfg = {"endpoint": f"http://127.0.0.1:{srv.server_port}/", "api_key": "k", "deployment": "judge"}
    os.environ.update(AZURE_OPENAI_ENDPOINT="http://x", AZURE_OPENAI_KEY="k", AZURE_OPENAI_DEPLOYMENT="d", AZURE_OPENAI_INSECURE_TLS="true")
    from_env = settings()
    assert from_env and from_env["api_key"] == "k" and from_env["insecure_tls"] and "temperature" not in json.dumps(from_env)
    got = ask("hello", cfg)
    assert got["text"] == '{"ok": true}' and got["model"] == "gpt-test-2026"
    assert seen["path"] == "/openai/v1/chat/completions" and seen["key"] == "k" and seen["body"]["model"] == "judge"
    try:
        ask("fail", cfg)
        raise SystemExit("expected an error")
    except RuntimeError as err:
        assert "azure 429" in str(err)
    srv.shutdown()
    print("azure.py: ok")
