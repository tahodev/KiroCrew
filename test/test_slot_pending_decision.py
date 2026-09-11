"""Tests for the slot's ``pending_decision`` payload — a buried [OPTIONS:] ask.

The scenario this exists for: a monitor/goal loop's agent ends a turn with
``[OPTIONS: …]``, the user is away, and later loop cycles append option-less
replies on top. The composer chips derive from the NEWEST assistant row, so the
question is now invisible everywhere — the user returns and has to ask "what's
waiting on me?".

``pending_decision`` is the projection-derived answer: the newest assistant
turn carries no options, an earlier one still does, and no human row sits in
between. It is deliberately narrower than its neighbours — ``has_options`` is
the marker on the newest row (chips already visible, nothing owed a badge; that
boundary is pinned by test_slot_needs_input_status.py), and ``needs_input`` is
an unanswered question card. Automation rows (``nudge``, ``inject``) neither
answer nor carry the decision; only a live ``user`` row retires it.

Derived, not stored: every ``to_dict`` re-reads the transcript, so there is no
lifecycle to desynchronise. The only state is the dismiss tombstone, which
names the options row's ``ts``.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from kiro_crew.dashboard.state import DashboardState, _ChatSlot

OPTIONS_TURN = "CTR failed twice on flaky suites.\n\n[OPTIONS: Retry again | Check mainline | Stop]"
CYCLE_REPLY = "Cycle 12: board unchanged, still blocked on your call."


def _state(*slot_keys: str) -> DashboardState:
    """A partially-constructed DashboardState owning real slots.

    Matches the fixture style of test_slot_needs_input_status.py;
    ``push_slots_update`` is a mock so a dismissal can be asserted to have been
    PUSHED, not merely stored.
    """
    st = DashboardState.__new__(DashboardState)
    st._slots = {k: _ChatSlot(k) for k in slot_keys}
    st.push_slots_update = MagicMock()  # type: ignore[method-assign]
    st._log = MagicMock()
    return st


def _turn(slot: _ChatSlot, *rows: tuple[str, str]) -> _ChatSlot:
    """Append LIVE rows (broadcast=True), the shape a real turn produces."""
    for role, content in rows:
        slot.append(role, content, broadcast=True)
    return slot


# ── the boundary: visible chips are not a buried decision ──


def test_fresh_options_turn_is_not_pending() -> None:
    """Options on the NEWEST turn are the composer chips' job, not a badge."""
    slot = _turn(
        _ChatSlot("chat-1"),
        ("user", "which one?"),
        ("assistant", OPTIONS_TURN),
    )
    payload = slot.to_dict()
    assert payload["pending_decision"] is None
    assert payload["has_options"] is True


def test_plain_conversation_is_not_pending() -> None:
    """An ordinary option-less reply after a user row raises nothing."""
    slot = _turn(
        _ChatSlot("chat-1"),
        ("user", "do the thing"),
        ("assistant", "done, 3 files changed"),
    )
    payload = slot.to_dict()
    assert payload["pending_decision"] is None
    assert payload["has_options"] is False


def test_automation_rows_alone_do_not_bury() -> None:
    """A nudge/inject row without a newer assistant reply leaves chips live."""
    slot = _turn(
        _ChatSlot("chat-1"),
        ("assistant", OPTIONS_TURN),
        ("nudge", "[auto-nudge cycle 12]\ncheck the board"),
        ("inject", "[Cron notification] scanner tick"),
    )
    payload = slot.to_dict()
    # The newest CONVERSATIONAL row is still the options turn.
    assert payload["has_options"] is True
    assert payload["pending_decision"] is None


# ── the case the feature exists for ──


def test_option_less_reply_buries_the_decision() -> None:
    slot = _turn(
        _ChatSlot("chat-1"),
        ("assistant", OPTIONS_TURN),
        ("nudge", "[auto-nudge cycle 12]\ncheck the board"),
        ("assistant", CYCLE_REPLY),
    )
    payload = slot.to_dict()
    assert payload["has_options"] is False
    pending = payload["pending_decision"]
    assert pending is not None
    assert pending["options"] == ["Retry again", "Check mainline", "Stop"]
    assert "CTR failed twice" in pending["excerpt"]
    assert "[OPTIONS:" not in pending["excerpt"]
    assert pending["ts"], "the options row's ts names the decision for dismissal"


def test_user_row_after_the_marker_retires_it() -> None:
    """A human message between the marker and now IS the answer channel."""
    slot = _turn(
        _ChatSlot("chat-1"),
        ("assistant", OPTIONS_TURN),
        ("user", "Retry again"),
        ("assistant", CYCLE_REPLY),
    )
    assert slot.to_dict()["pending_decision"] is None


def test_tool_rows_between_do_not_retire() -> None:
    """Loop-cycle plumbing (tool activity, notices) is transparent to the scan."""
    slot = _turn(
        _ChatSlot("chat-1"),
        ("assistant", OPTIONS_TURN),
        ("nudge", "[auto-nudge cycle 12]\ngo"),
        ("tool_call", "gh pr checks 123"),
        ("tool_result", "all green"),
        ("assistant", CYCLE_REPLY),
    )
    assert slot.to_dict()["pending_decision"] is not None


def test_newer_options_turn_supersedes_older_one() -> None:
    """The newest unanswered marker wins; an older one is never resurrected."""
    slot = _turn(
        _ChatSlot("chat-1"),
        ("assistant", "First ask.\n\n[OPTIONS: Old A | Old B]"),
        ("assistant", "Second ask.\n\n[OPTIONS: New A | New B]"),
        ("assistant", CYCLE_REPLY),
    )
    pending = slot.to_dict()["pending_decision"]
    assert pending is not None
    assert pending["options"] == ["New A", "New B"]


def test_scan_gives_up_past_the_row_cap() -> None:
    """The backward scan is bounded; a decision buried deeper is dropped."""
    slot = _turn(_ChatSlot("chat-1"), ("assistant", OPTIONS_TURN))
    for i in range(160):
        slot.append("tool_result", f"tick {i}", broadcast=True)
    slot.append("assistant", CYCLE_REPLY, broadcast=True)
    assert slot.to_dict()["pending_decision"] is None


def test_excerpt_is_truncated() -> None:
    slot = _turn(
        _ChatSlot("chat-1"),
        ("assistant", ("x" * 500) + "\n\n[OPTIONS: A | B]"),
        ("assistant", CYCLE_REPLY),
    )
    pending = slot.to_dict()["pending_decision"]
    assert pending is not None
    assert len(pending["excerpt"]) <= 241  # 240 + ellipsis


# ── dismissal: a tombstone naming the message, not a state delete ──


def test_dismiss_silences_exactly_that_decision() -> None:
    st = _state("chat-1")
    slot = _turn(
        st._slots["chat-1"],
        ("assistant", OPTIONS_TURN),
        ("assistant", CYCLE_REPLY),
    )
    pending = slot.to_dict()["pending_decision"]
    assert pending is not None
    assert st.dismiss_pending_decision("chat-1", pending["ts"]) is True
    st.push_slots_update.assert_called()
    assert slot.to_dict()["pending_decision"] is None

    # A LATER options turn is a NEW decision with a new ts: it surfaces.
    slot.append("assistant", "Round two.\n\n[OPTIONS: Ship it | Hold]", broadcast=True)
    slot.append("assistant", CYCLE_REPLY, broadcast=True)
    revived = slot.to_dict()["pending_decision"]
    assert revived is not None
    assert revived["options"] == ["Ship it", "Hold"]


def test_dismiss_refuses_unknown_slot_and_blank_ts() -> None:
    st = _state("chat-1")
    assert st.dismiss_pending_decision("nope", "2026-01-01T00:00:00") is False
    assert st.dismiss_pending_decision("chat-1", "") is False
    st.push_slots_update.assert_not_called()
