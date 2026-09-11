"""The member task board shares the real ledger behind an owner and generation gate."""

import asyncio
from types import SimpleNamespace

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from dashboard_owner_helpers import as_owner

from kiro_crew import member_memory_auth, members, work_ledger
from kiro_crew.config.loader import KiroCrewAgentConfig, KiroCrewConfig
from kiro_crew.dashboard.handlers import member_work
from kiro_crew.dashboard.routes import agents as member_routes
from kiro_crew.member_memory_auth import bind_private_session_store
from kiro_crew.memory_stores import provision_member_memory

MEMBER = "Reviewer"
SLUG = "reviewer"


@pytest.fixture
def member_app(monkeypatch):
    cfg = KiroCrewConfig.load()
    cfg.agents[MEMBER] = KiroCrewAgentConfig(kiro_agent="kirocrew")
    store = provision_member_memory(cfg, MEMBER)
    cfg.save()
    key = members.member_slot_key(SLUG, store)

    # Exercise real ownership records and readers; publication atomicity is
    # covered separately and the host may lack renameat2 (older Linux libc).
    def publish_fixture(staging, destination):
        assert not destination.exists()
        staging.rename(destination)

    with monkeypatch.context() as publication:
        publication.setattr(member_memory_auth, "_publish_private_binding_dir", publish_fixture)
        bind_private_session_store(f"dashboard:{key}", store)
    members.write_dm_binding(SLUG, member=MEMBER, slot_key=key, memory_store=store)
    slot = SimpleNamespace(
        key=key,
        mode=members.DM_SLOT_MODE,
        agent=MEMBER,
        memory_store=store,
        running=False,
        _lock=asyncio.Lock(),
    )
    slots = {key: slot}
    app = web.Application()

    @web.middleware
    async def internal_identity(request, handler):
        if request.headers.get("X-Test-Internal"):
            request["internal_auth"] = True
        return await handler(request)

    app.middlewares.append(internal_identity)
    app["state"] = SimpleNamespace(owner_id="", _slots=slots, get_slot=slots.get)
    member_routes.register(app)
    monkeypatch.setattr(KiroCrewConfig, "load", staticmethod(lambda: cfg))
    return as_owner(app), cfg, slot, f"/api/members/{SLUG}/work?member={MEMBER}&slot={key}"


@pytest.mark.asyncio
async def test_owner_capture_and_worker_reports_share_the_same_record(member_app):
    app, _, slot, url = member_app
    async with TestClient(TestServer(app)) as client:
        response = await client.get(url)
        assert response.status == 200, await response.text()
        assert (await response.json())["items"] == []
        response = await client.post(
            url, json={"title": "Review the change", "criteria": "All checks pass"}
        )
        assert response.status == 201, await response.text()
        item = (await response.json())["item"]
        assert item["state"] == "open"
        assert item["status"] is None
        assert item["worker_session_key"] is None
        assert item["acceptance"] == {
            "kind": "human_approval",
            "description": "All checks pass",
        }
        work_ledger.apply_conductor_action(
            slot.key, "bind", item_id=item["item_id"], worker_session_key="worker"
        )
        binding = work_ledger.read_binding("worker")
        assert binding == (slot.key, item["item_id"])
        work_ledger.apply_worker_report(
            *binding, status="done", summary="Checks passed", artifacts={"result": "report.txt"}
        )
        response = await client.get(url)
        payload = await response.json()
        assert response.status == 200, payload
        assert "accept_batch" not in payload
        assert payload["slot_key"] == slot.key
        assert payload["items"][0]["summary"] == "Checks passed"
        assert payload["items"][0]["status"] == "done"
        assert payload["items"][0]["state"] == "open"
        assert payload["items"][0]["events"][-1]["kind"] == "report"


@pytest.mark.asyncio
async def test_worker_credentials_are_redacted_without_breaking_json(member_app):
    app, _, slot, url = member_app
    async with TestClient(TestServer(app)) as client:
        created = await client.post(url, json={"title": "Review", "criteria": "Checks pass"})
        item = (await created.json())["item"]
        work_ledger.apply_conductor_action(
            slot.key, "bind", item_id=item["item_id"], worker_session_key="worker"
        )
        work_ledger.apply_worker_report(
            slot.key,
            item["item_id"],
            status="progress",
            summary='Keep "quoted", bracketed } text',
            artifacts={"aws_secret_access_key": "example", "report": 'notes "quoted".txt'},
        )
        response = await client.get(url)
        assert response.status == 200, await response.text()
        row = (await response.json())["items"][0]
        assert row["artifacts"]["aws_secret_access_key"] == "[REDACTED]"
        assert row["artifacts"]["report"] == 'notes "quoted".txt'
        assert row["summary"] == 'Keep "quoted", bracketed } text'


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "headers,status",
    [
        ({"X-Test-User": "other-person"}, 403),
        ({"X-Test-App": "some-app"}, 404),
        ({"X-Test-Internal": "1"}, 403),
    ],
)
async def test_non_owner_cannot_read_or_create(member_app, headers, status):
    app, _, slot, url = member_app
    async with TestClient(TestServer(app)) as client:
        assert (await client.get(url, headers=headers)).status == status
        assert (await client.post(url, data="{", headers=headers)).status == status
    assert work_ledger.read_conductor(slot.key) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("mismatch", ["hint", "member", "generation", "live-agent", "private"])
async def test_stale_or_foreign_identity_is_not_a_ledger_selector(member_app, mismatch):
    app, cfg, slot, url = member_app
    if mismatch == "hint":
        url = url.replace(f"slot={slot.key}", "slot=some-other-session")
    elif mismatch == "member":
        cfg.agents["reviewer"] = cfg.agents[MEMBER]
        url = url.replace(f"member={MEMBER}", "member=reviewer")
    elif mismatch == "generation":
        members.write_dm_binding(SLUG, member=MEMBER, slot_key=members.member_slot_key(SLUG))
    elif mismatch == "live-agent":
        slot.agent = "Someone else"
    else:
        slot.memory_store = "default"
    async with TestClient(TestServer(app)) as client:
        for response in (
            await client.get(url),
            await client.post(url, json={"title": "wrong", "criteria": "wrong"}),
        ):
            assert response.status == 409, await response.text()
    assert work_ledger.read_conductor(slot.key) is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        {"title": "", "criteria": "test"},
        {"title": "task", "criteria": " "},
        {"title": "x" * 201, "criteria": "test"},
        {"title": "task", "criteria": "x" * 4001},
        {"title": "task", "criteria": "test", "state": "accepted"},
    ],
)
async def test_invalid_capture_cannot_write_ledger_fields(member_app, body):
    app, _, slot, url = member_app
    async with TestClient(TestServer(app)) as client:
        assert (await client.post(url, json=body)).status == 400
    assert work_ledger.read_conductor(slot.key) is None


@pytest.mark.asyncio
async def test_revalidate_member_after_awaited_read(member_app, monkeypatch):
    app, _, slot, url = member_app
    work_ledger.ensure_conductor(slot.key)
    original = member_work.read_ledger_snapshot

    async def renamed(*args):
        payload = await original(*args)
        slot.agent = "Renamed"
        return payload

    monkeypatch.setattr(member_work, "read_ledger_snapshot", renamed)
    async with TestClient(TestServer(app)) as client:
        assert (await client.get(url)).status == 409


@pytest.mark.asyncio
async def test_unreadable_ledger_is_an_error_not_an_empty_board(member_app, monkeypatch):
    app, _, _, url = member_app

    def unavailable(*args, **kwargs):
        raise OSError("disk unavailable")

    monkeypatch.setattr(work_ledger, "read_conductor", unavailable)
    async with TestClient(TestServer(app)) as client:
        response = await client.get(url)
        assert response.status == 503
        assert (await response.json())["code"] == "member_work_unavailable"
