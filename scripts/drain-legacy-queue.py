"""Quiesce an archived AMQP release before a BullMQ cutover.

Called by deploy.sh while its deployment lock and rollback trap are active.
Only stops the selected old API/worker; broker, database and volumes stay intact.
"""

from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable


SPEC = importlib.util.spec_from_file_location("deploy_diagnostics", Path(__file__).with_name("deploy-diagnostics.py"))
diagnostics = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(diagnostics)


class CutoverUnavailable(Exception):
    pass


def stop_service(compose: list[str], service: str) -> None:
    try:
        # The archived worker has a 30-second task limit and a 120-second stop
        # grace. Capture all Docker output: daemon errors can contain secrets.
        result = subprocess.run([*compose, "stop", "--timeout", "120" if service == "worker" else "30", service],
                                capture_output=True, timeout=150, check=False)
        if result.returncode:
            raise CutoverUnavailable("Could not stop the old application service.")
    except (OSError, subprocess.TimeoutExpired):
        raise CutoverUnavailable("Could not stop the old application service.") from None


def verified_sample(sample: dict) -> None:
    if sample.get("status") != "ok" or sample.get("legacy_container_present") is not True or type(sample.get("pending_work")) is not bool:
        raise CutoverUnavailable("Legacy work counts are unavailable; cutover was refused.")


def drain(project: str, compose: list[str], *, probe: Callable[[], dict] | None = None,
          stop: Callable[[list[str], str], None] = stop_service,
          clock: Callable[[], float] = time.monotonic,
          sleep: Callable[[float], None] = time.sleep,
          timeout: float = 120, interval: float = 2) -> None:
    probe = probe or (lambda: diagnostics.legacy_queue_status(project, diagnostics.readonly_command))
    # The archived Compose declares RabbitMQ. Missing or unprovable running
    # container identity must not be mistaken for an empty legacy queue.
    verified_sample(probe())
    print("Legacy cutover: stopping old API ingress.", flush=True)
    stop(compose, "api")
    deadline = clock() + timeout
    while True:
        if clock() > deadline:
            raise CutoverUnavailable("Legacy work did not drain before the deadline; cutover was refused.")
        sample = probe()
        verified_sample(sample)
        if clock() > deadline:
            raise CutoverUnavailable("Legacy work did not drain before the deadline; cutover was refused.")
        if sample["pending_work"] is False:
            break
        remaining = deadline - clock()
        if remaining <= 0:
            raise CutoverUnavailable("Legacy work did not drain before the deadline; cutover was refused.")
        sleep(min(interval, remaining))
    print("Legacy cutover: stopping the drained old worker.", flush=True)
    stop(compose, "worker")
    final = probe()
    verified_sample(final)
    if final["pending_work"] is not False or final.get("rabbitmq", {}).get("consumers") != 0:
        raise CutoverUnavailable("Legacy work or consumers remain after worker stop; cutover was refused.")
    print("Legacy cutover: SQL and broker work are empty; old consumers are stopped.", flush=True)


def main(arguments: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if arguments is None else arguments
    if len(arguments) < 5 or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", arguments[0]) or len(arguments[0]) > 63 or arguments[1:4] != ["--", "docker", "compose"]:
        print("Legacy cutover requires a project and its archived Docker Compose command.", file=sys.stderr)
        return 2
    try:
        drain(arguments[0], arguments[2:])
    except CutoverUnavailable as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
