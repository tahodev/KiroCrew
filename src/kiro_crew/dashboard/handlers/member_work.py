"""Owner-dashboard view and task capture for a member's conductor work ledger."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from aiohttp import web

from kiro_crew import members, session_ledger, work_ledger
from kiro_crew.config.loader import KiroCrewConfig
from kiro_crew.dashboard.chat_utils import effective_session_key
from kiro_crew.dashboard.handlers._shared import (
    read_bounded_json,
    require_owner_dashboard_request,
)
from kiro_crew.dashboard.handlers.members import _deny_app_caller, _member_thread_slot
from kiro_crew.dashboard.handlers.work_ledger import read_ledger_snapshot
from kiro_crew.dashboard.state import DashboardState
from kiro_crew.member_memory_auth import read_private_session_store
from kiro_crew.security import redact

logger = logging.getLogger(__name__)

MAX_TASK_CRITERIA_CHARS = 4000


def _changed_thread() -> web.Response:
    return web.json_response(
        {
            "error": "Open this member's current conversation before accessing its tasks.",
            "code": "member_work_thread_changed",
        },
        status=409,
    )


async def _member_key(request: web.Request) -> str | web.Response:
    """Resolve the exact member and current generation, never a supplied session."""
    denied = await _deny_app_caller(request, "members.work")
    if denied is not None:
        return denied
    if request.get("internal_auth"):
        return web.json_response(
            {"error": "Only the dashboard owner can access member tasks.", "code": "owner_only"},
            status=403,
        )
    denied = await require_owner_dashboard_request(request, "members.work")
    if denied is not None:
        return denied
    slug = request.match_info["slug"]
    try:
        members.validate_slug(slug)
    except members.MemberSlugError:
        return web.json_response(
            {"error": "Invalid member slug.", "code": "invalid_member_slug"}, status=400
        )
    member = request.query.get("member", "")
    cfg = await asyncio.to_thread(KiroCrewConfig.load)
    if not member or member not in cfg.agents or members.slug_for_name(member) != slug:
        return web.json_response(
            {"error": "Member not found.", "code": "member_not_found"}, status=404
        )
    state: DashboardState | None = request.app.get("state")
    if state is None:
        return web.json_response(
            {"error": "Dashboard state unavailable.", "code": "state_unavailable"}, status=503
        )
    try:
        key, generation = await asyncio.to_thread(_member_thread_slot, cfg, member, slug)
        binding = await asyncio.to_thread(members.read_dm_binding, slug)
    except (OSError, ValueError):
        logger.warning("Member work identity unavailable", exc_info=True)
        return _changed_thread()
    if (
        not binding
        or binding.get("member") != member
        or binding.get("slot_key") != key
        or binding.get("memory_store", "") != generation
        or request.query.get("slot") != key
    ):
        return _changed_thread()
    slot = state._slots.get(key)
    if (
        slot is None
        or slot.mode != members.DM_SLOT_MODE
        or slot.agent != member
        or effective_session_key(slot) != f"dashboard:{key}"
    ):
        return _changed_thread()
    store = cfg.agents[member].memory_store
    store_record = cfg.memory_stores.get(store)
    if store_record is not None and store_record.memory_version == 2:
        try:
            bound = await asyncio.to_thread(read_private_session_store, f"dashboard:{key}")
        except (OSError, ValueError):
            return _changed_thread()
        if bound != store or slot.memory_store != store:
            return _changed_thread()
    # The private proof read yields to slot replacement, rename and channel linking.
    if (
        state._slots.get(key) is not slot
        or slot.mode != members.DM_SLOT_MODE
        or slot.agent != member
        or effective_session_key(slot) != f"dashboard:{key}"
    ):
        return _changed_thread()
    return key


def _audit(request: web.Request, key: str, operation: str) -> None:
    try:
        from kiro_crew.sel import sel

        sel().log_api_access(
            caller=str(request.get("user") or ""),
            operation=operation,
            outcome="allowed",
            source="dashboard",
            resources=key,
        )
    except Exception:  # pragma: no cover - auditing does not replace authorization
        logger.debug("Member work audit failed", exc_info=True)


def _safe_payload(value: Any) -> Any:
    """Redact fields without handing JSON delimiters to the text redactor."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, list):
        return [_safe_payload(item) for item in value]
    if isinstance(value, dict):
        result = {}
        for key, child in value.items():
            # A credential field can carry an otherwise unrecognizable value.
            # Keep its key/value context for detection, but mask the value as
            # data instead of reparsing the redactor's replacement text.
            field = f"{key}={child}" if isinstance(child, str) else None
            result[redact(key)] = (
                "[REDACTED]"
                if field is not None and redact(field) != field
                else _safe_payload(child)
            )
        return result
    return value


async def api_member_work(request: web.Request) -> web.Response:
    """GET the selected member's own ledger without changing the agent-only routes."""
    key = await _member_key(request)
    if isinstance(key, web.Response):
        return key
    try:
        record = await asyncio.to_thread(work_ledger.read_conductor, key, strict=True)
        payload = (
            await read_ledger_snapshot(request.app["state"], key, record)
            if record is not None
            else {"conductor": None, "items": []}
        )
        checkpoint = await asyncio.to_thread(session_ledger.read_state, key)
    except (OSError, ValueError):
        logger.warning("Member work read failed", exc_info=True)
        return web.json_response(
            {"error": "Could not read the member's tasks.", "code": "member_work_unavailable"},
            status=503,
        )
    # An opt-in or rename can land during a disk read. Never return the old
    # generation's work under the member identity the browser now displays.
    current = await _member_key(request)
    if isinstance(current, web.Response):
        return current
    if current != key:
        return _changed_thread()
    payload.pop("accept_batch", None)
    payload.update(
        slot_key=key,
        checkpoint=checkpoint,
        limits={
            "title": work_ledger.MAX_TITLE_CHARS,
            "criteria": MAX_TASK_CRITERIA_CHARS,
        },
    )
    _audit(request, key, "members.work.read")
    return web.json_response(_safe_payload(payload))


def _create_task(key: str, title: str, criteria: str) -> dict[str, Any]:
    work_ledger.ensure_conductor(key)
    result = work_ledger.apply_conductor_action(
        key, "create", title=title, acceptance={"kind": "human_approval", "description": criteria}
    )
    return result["item"].to_dict()


async def api_member_work_create(request: web.Request) -> web.Response:
    """Capture an owner-authored task; starting execution remains an explicit send."""
    key = await _member_key(request)
    if isinstance(key, web.Response):
        return key
    body, denied = await read_bounded_json(request)
    if denied is not None:
        return denied
    assert body is not None
    title = body.get("title")
    criteria = body.get("criteria")
    if (
        set(body) != {"title", "criteria"}
        or not isinstance(title, str)
        or not title.strip()
        or len(title) > work_ledger.MAX_TITLE_CHARS
        or not isinstance(criteria, str)
        or not criteria.strip()
        or len(criteria) > MAX_TASK_CRITERIA_CHARS
    ):
        return web.json_response(
            {
                "error": "Provide a task title and acceptance criteria within the field limits.",
                "code": "invalid_member_task",
            },
            status=400,
        )
    state: DashboardState = request.app["state"]
    slot = state._slots.get(key)
    if slot is None:
        return _changed_thread()
    async with slot._lock:
        current = await _member_key(request)
        if isinstance(current, web.Response):
            return current
        if current != key or state._slots.get(key) is not slot:
            return _changed_thread()
        try:
            item = await asyncio.to_thread(
                _create_task, key, redact(title.strip()), redact(criteria.strip())
            )
        except work_ledger.WorkLedgerError as exc:
            return web.json_response(
                {"error": redact(str(exc)), "code": exc.code, "field": exc.field}, status=409
            )
        except (OSError, ValueError):
            logger.warning("Member task creation failed", exc_info=True)
            return web.json_response(
                {"error": "Could not save the task.", "code": "member_work_unavailable"}, status=503
            )
    _audit(request, key, "members.work.create")
    return web.json_response(_safe_payload({"item": item, "slot_key": key}), status=201)
