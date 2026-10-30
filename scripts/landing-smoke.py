"""Check the built static landing without requiring JavaScript or analytics availability."""

import os
from html.parser import HTMLParser
from urllib.error import HTTPError
from urllib.request import urlopen

BASE_URL = os.environ.get("SMOKE_BASE_URL", "http://landing:8080").rstrip("/")


class Landing(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = set()
        self.has_heading = False
        self.has_app_link = False

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        self.has_heading |= tag == "h1"
        self.has_app_link |= tag == "a" and "data-app-link" in values
        for name in ("src", "href"):
            value = values.get(name)
            if value and value.startswith("/assets/"):
                self.paths.add(value)


def get(path):
    with urlopen(BASE_URL + path, timeout=10) as response:
        return response.headers, response.read()


def main():
    headers, index = get("/")
    assert "text/html" in headers.get("Content-Type", ""), "Landing index is not HTML"
    assert "no-cache" in headers.get("Cache-Control", ""), "Landing index must revalidate"
    page = Landing()
    page.feed(index.decode())
    assert page.has_heading and page.has_app_link, "Landing core content is missing from HTML"
    assert page.paths, "Landing index contains no built assets"
    for path in page.paths:
        asset_headers, content = get(path)
        assert content and "text/html" not in asset_headers.get("Content-Type", ""), (
            "Landing asset returned HTML"
        )
        assert "immutable" in asset_headers.get("Cache-Control", ""), (
            "Landing assets must be immutable"
        )
    get("/landing-health")
    for path in ("/assets/missing-smoke-asset.js", "/landing-smoke-unknown-route"):
        try:
            get(path)
        except HTTPError as error:
            assert error.code == 404, "Unknown landing paths must return 404"
        else:
            raise AssertionError("Unknown landing path unexpectedly succeeded")
    print("Landing smoke OK: static content, assets, health and true 404s")


if __name__ == "__main__":
    main()
