"""Check the built SPA and reverse proxy from inside the trusted API container."""

import json
import os
from html.parser import HTMLParser
from urllib.error import HTTPError
from urllib.request import Request, urlopen

BASE_URL = os.environ.get("SMOKE_BASE_URL", "http://frontend:8080")
SMOKE_HOST = os.environ.get("SMOKE_HOST", "localhost")


class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = set()

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name in {"src", "href"} and value and value.startswith("/assets/"):
                self.paths.add(value)


def get(path):
    with urlopen(Request(BASE_URL + path, headers={"Host": SMOKE_HOST}), timeout=10) as response:
        return response.headers, response.read()


def main():
    headers, index = get("/")
    assert "text/html" in headers.get("Content-Type", ""), "Frontend index is not HTML"
    assert "no-cache" in headers.get("Cache-Control", ""), "Frontend index must revalidate"
    _, nested = get("/workspace/example")
    assert nested == index, "SPA deep link did not receive the index"
    assets = Assets()
    assets.feed(index.decode())
    assert assets.paths, "Frontend index contains no built assets"
    for path in assets.paths:
        asset_headers, content = get(path)
        assert content and "text/html" not in asset_headers.get("Content-Type", ""), (
            "Asset request returned the SPA index"
        )
        assert "immutable" in asset_headers.get("Cache-Control", ""), (
            "Built asset must be immutable"
        )
    try:
        get("/assets/missing-smoke-asset.js")
    except HTTPError as error:
        assert error.code == 404, "Missing asset must return 404"
    else:
        raise AssertionError("Missing asset unexpectedly returned success")
    get("/frontend-health")
    for path in ("/health/live", "/health/ready"):
        _, content = get(path)
        assert json.loads(content)["status"] == "ok", "Backend health proxy failed"
    try:
        get("/api/v1/frontend-smoke-missing")
    except HTTPError as error:
        assert error.code == 404, "Unknown API route must remain 404"
        assert "application/json" in error.headers.get("Content-Type", ""), (
            "Unknown API route returned SPA HTML"
        )
        json.load(error)
    else:
        raise AssertionError("Unknown API route unexpectedly returned success")
    unauthenticated = Request(
        BASE_URL + "/api/v1/jobs",
        data=json.dumps({"text": "smoke", "operation": "uppercase"}).encode(),
        headers={"Content-Type": "application/json", "Host": SMOKE_HOST},
    )
    try:
        urlopen(unauthenticated, timeout=10)
    except HTTPError as error:
        assert error.code == 401, "API proxy did not preserve authentication"
    else:
        raise AssertionError("Unauthenticated API request unexpectedly succeeded")
    print("Frontend smoke OK: SPA, assets, health proxy and authentication")


if __name__ == "__main__":
    main()
