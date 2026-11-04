"""Registered business checks. Configuration selects names, never executable code.

The scoped preflight checks current ownership/status. The upstream mutation must
still enforce them atomically (or use a resource version); a read cannot close that race.
"""
from __future__ import annotations

from typing import Any, Awaitable, Callable

GUARDS = frozenset({"orders.cancel_before_shipment"})


class GuardRejected(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


async def check_guard(operation: dict, arguments: dict, catalog: dict[str, dict], read: Callable[[dict, dict], Awaitable[Any]]) -> None:
    guard = operation["guard"]
    if guard is None:
        return
    if guard not in GUARDS:
        raise GuardRejected("unknown_guard")
    if guard == "orders.cancel_before_shipment":
        target = catalog[operation["reconciliation"]["operationKey"]]
        inputs = {name: arguments[name] for name in target["parameters"] if name in arguments}
        inputs["eldhall"] = arguments["eldhall"]
        data = await read(target, inputs)
        if not isinstance(data, dict) or data.get("order_id") != arguments.get("order_id"):
            raise GuardRejected("ownership_unconfirmed")
        # A cancelled order may be the replay of this same durable action. Only
        # the upstream can verify the key atomically; it must reject a different
        # key on an already cancelled order, and replay the matching one.
        replay_candidate = data.get("status") == "cancelled" and operation["idempotency"] and arguments["eldhall"].get("idempotencyKey")
        if data.get("status") != "paid" and not replay_candidate:
            raise GuardRejected("not_cancellable")
