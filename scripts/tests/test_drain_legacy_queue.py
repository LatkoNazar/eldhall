import importlib.util
import io
import subprocess
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("drain_legacy_queue", Path(__file__).resolve().parents[1] / "drain-legacy-queue.py")
cutover = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cutover)


def sample(pending=False, consumers=3):
    return {"status": "ok", "legacy_container_present": True, "pending_work": pending,
            "rabbitmq": {"status": "ok", "consumers": consumers}}


class LegacyCutoverTests(unittest.TestCase):
    def exercise(self, samples, *, timeout=120):
        events, now = [], [0]
        iterator = iter(samples)
        latest = [None]

        def probe():
            latest[0] = next(iterator, latest[0])
            events.append(("probe", latest[0]))
            return latest[0]

        def stop(compose, service):
            self.assertEqual(compose, ["docker", "compose", "--env-file", "/private/.env", "-f", "/private/old/compose.yaml"])
            events.append(("stop", service))

        def sleep(duration):
            now[0] += duration
            events.append(("wait", duration))

        return events, lambda: cutover.drain("starter", ["docker", "compose", "--env-file", "/private/.env", "-f", "/private/old/compose.yaml"],
                                              probe=probe, stop=stop, clock=lambda: now[0], sleep=sleep, timeout=timeout)

    def test_pending_work_finishes_after_ingress_stops_before_worker_stop_and_final_proof(self):
        events, run = self.exercise([sample(True), sample(True), sample(True), sample(), sample(consumers=0)])
        with redirect_stdout(io.StringIO()):
            run()
        self.assertEqual([event[0] if event[0] != "stop" else event[1] for event in events],
                         ["probe", "api", "probe", "wait", "probe", "wait", "probe", "worker", "probe"])

    def test_timeout_leaves_old_worker_running_and_never_treats_pending_as_empty(self):
        events, run = self.exercise([sample(True)], timeout=5)
        with redirect_stdout(io.StringIO()), self.assertRaisesRegex(cutover.CutoverUnavailable, "deadline"):
            run()
        self.assertEqual([event[1] for event in events if event[0] == "stop"], ["api"])
        self.assertEqual(sum(event[1] for event in events if event[0] == "wait"), 5)

    def test_missing_or_unknown_counts_refuse_before_stop_or_during_drain(self):
        for bad in ({"status": "no_legacy_container"}, {"status": "unavailable"},
                    {"status": "ok", "legacy_container_present": True, "pending_work": None}):
            for initial in (True, False):
                with self.subTest(bad=bad, initial=initial):
                    events, run = self.exercise([bad] if initial else [sample(), bad])
                    with redirect_stdout(io.StringIO()), self.assertRaisesRegex(cutover.CutoverUnavailable, "unavailable"):
                        run()
                    self.assertEqual([event[1] for event in events if event[0] == "stop"], [] if initial else ["api"])

    def test_new_work_or_remaining_consumers_after_worker_stop_refuses_cutover(self):
        for final in (sample(True, 0), sample(False, 1), {"status": "unavailable"}):
            with self.subTest(final=final):
                events, run = self.exercise([sample(), sample(), final])
                with redirect_stdout(io.StringIO()), self.assertRaises(cutover.CutoverUnavailable):
                    run()
                self.assertEqual([event[1] for event in events if event[0] == "stop"], ["api", "worker"])

    def test_stop_commands_are_scoped_and_errors_do_not_disclose_docker_output(self):
        for service, grace in (("api", "30"), ("worker", "120")):
            with self.subTest(service=service), patch.object(cutover.subprocess, "run") as run:
                run.return_value = subprocess.CompletedProcess([], 1, b"private-token", b"private-path")
                with self.assertRaises(cutover.CutoverUnavailable) as raised:
                    cutover.stop_service(["docker", "compose", "-f", "/private/old.yaml"], service)
                self.assertEqual(run.call_args.args[0], ["docker", "compose", "-f", "/private/old.yaml", "stop", "--timeout", grace, service])
                self.assertNotIn("private", str(raised.exception))
        output, error = io.StringIO(), io.StringIO()
        with patch.object(cutover, "drain", side_effect=cutover.CutoverUnavailable("Legacy work counts are unavailable; cutover was refused.")):
            with redirect_stdout(output), redirect_stderr(error):
                self.assertEqual(cutover.main(["starter", "--", "docker", "compose", "-f", "/private/old.yaml"]), 1)
        self.assertNotIn("private", output.getvalue() + error.getvalue())


if __name__ == "__main__":
    unittest.main()
