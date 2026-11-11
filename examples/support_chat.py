"""Send a message to a development Eldhall installation with Python 3.10+."""

import argparse
import json
import os
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID, uuid4


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class CustomerChat:
    def __init__(self, origin: str, session_token: str):
        url = urlsplit(origin)
        loopback = url.hostname in {"localhost", "127.0.0.1", "::1"}
        if (
            not url.hostname
            or url.username is not None
            or url.password is not None
            or url.path not in {"", "/"}
            or url.query
            or url.fragment
            or not (url.scheme == "https" or (url.scheme == "http" and loopback))
        ):
            raise ValueError("Use an HTTPS origin or an HTTP loopback origin.")
        self.origin = origin.rstrip("/")
        self.session_token = session_token
        self.opener = build_opener(NoRedirects())

    def request(self, method: str, path: str, payload: dict | None = None, timeout: float = 10):
        headers = {"Accept": "application/json", "X-Customer-Session": self.session_token}
        body = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(payload).encode("utf-8")
        request = Request(self.origin + path, data=body, headers=headers, method=method)
        with self.opener.open(request, timeout=timeout) as response:
            return response.status, json.load(response)

    def open_case(self):
        _, case = self.request("POST", "/api/v1/chat/cases")
        return UUID(case["id"])

    def send(self, case_id: UUID, message_id: UUID, message: str):
        return self.request(
            "POST",
            f"/api/v1/chat/cases/{case_id}/messages",
            {"body": message, "clientMessageId": str(message_id)},
            timeout=130,
        )

    def history(self, case_id: UUID, timeout: float = 10):
        _, case = self.request("GET", f"/api/v1/chat/cases/{case_id}", timeout=timeout)
        return case

    def wait_for_turn(self, case_id: UUID, run_id: str, seconds: float = 45):
        deadline = time.monotonic() + seconds
        delay = 1.0
        while (remaining := deadline - time.monotonic()) > 0:
            case = self.history(case_id, timeout=min(10, remaining))
            active = case["activeRun"]
            if active is None or active["id"] != run_id:
                return case
            time.sleep(min(delay, max(0, deadline - time.monotonic())))
            delay = min(delay * 1.5, 5.0)
        raise TimeoutError("Polling ended. Read the same case again for the latest history.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("message", nargs="?", help="Message to send. Omit to read a case.")
    parser.add_argument("--case-id", type=UUID, help="Reuse an existing case.")
    parser.add_argument("--message-id", type=UUID, help="Replay the same worker-mode send.")
    args = parser.parse_args()
    if args.message is None and args.case_id is None:
        parser.error("Supply a message or --case-id.")
    if args.message_id and (args.case_id is None or args.message is None):
        parser.error("--message-id requires --case-id and the original message text.")
    message = args.message.strip() if args.message is not None else None
    if message is not None and not 1 <= len(message.encode("utf-16-le")) // 2 <= 2000:
        parser.error("The message must be nonblank and at most 2,000 UTF-16 units.")
    origin = os.environ.get("ELDHALL_API_URL")
    session = os.environ.get("ELDHALL_CUSTOMER_SESSION")
    if not origin or not session:
        parser.error("Set ELDHALL_API_URL and ELDHALL_CUSTOMER_SESSION.")

    try:
        chat = CustomerChat(origin, session)
        case_id = args.case_id or chat.open_case()
        print(f"case_id={case_id}", file=sys.stderr)
        if message is None:
            case = chat.history(case_id)
        else:
            message_id = args.message_id or uuid4()
            print(f"client_message_id={message_id}", file=sys.stderr)
            status, accepted = chat.send(case_id, message_id, message)
            run_id = accepted.get("runId")
            case = chat.wait_for_turn(case_id, run_id) if status == 202 and run_id else chat.history(case_id)
        print(json.dumps(case, ensure_ascii=False, indent=2))
    except HTTPError as error:
        print(f"Eldhall returned HTTP {error.code}.", file=sys.stderr)
        if error.code == 429 and error.headers.get("Retry-After"):
            print(f"Retry-After: {error.headers['Retry-After']} seconds.", file=sys.stderr)
        return 1
    except (KeyError, URLError, TimeoutError, ValueError) as error:
        print(f"Eldhall request could not complete ({type(error).__name__}).", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
