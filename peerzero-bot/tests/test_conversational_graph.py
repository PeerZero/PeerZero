"""Tests for conversational_memory.graph — Node/edge CRUD, weight management, ripple, identity relevance."""

import os
import tempfile
import pytest
from peerzero_bot.conversational_memory.db import ConversationalMemoryDB
from peerzero_bot.conversational_memory.config import ConversationalMemoryConfig
from peerzero_bot.conversational_memory.graph import Graph, VALID_TYPES, VALID_RELEVANCE, VALID_PROVENANCE


@pytest.fixture
def graph(tmp_path):
    db_path = str(tmp_path / "test.db")
    db = ConversationalMemoryDB(db_path, encryption_key="")
    db.connect()
    config = ConversationalMemoryConfig()
    g = Graph(db, config)
    yield g
    db.close()


# ── Node CRUD ────────────────────────────────────────────────────────────────

class TestNodeCRUD:
    def test_create_and_get_node(self, graph):
        node = graph.create_node("Alice", "person")
        assert node["label"] == "Alice"
        assert node["type"] == "person"
        assert node["identity_relevance"] == "neutral"
        assert node["provenance"] == "conversation"
        fetched = graph.get_node(node["id"])
        assert fetched is not None
        assert fetched["label"] == "Alice"

    def test_invalid_type_defaults_to_concept(self, graph):
        node = graph.create_node("test", "invalid_type")
        assert node["type"] == "concept"

    def test_invalid_relevance_defaults_to_neutral(self, graph):
        node = graph.create_node("test", "concept", identity_relevance="bogus")
        assert node["identity_relevance"] == "neutral"

    def test_invalid_provenance_defaults_to_conversation(self, graph):
        node = graph.create_node("test", "concept", provenance="bogus")
        assert node["provenance"] == "conversation"

    def test_get_nonexistent_node_returns_none(self, graph):
        assert graph.get_node("nonexistent-id") is None

    def test_find_node_by_label_case_insensitive(self, graph):
        graph.create_node("Alice", "person")
        found = graph.find_node_by_label("alice")
        assert found is not None
        assert found["label"] == "Alice"
        found2 = graph.find_node_by_label("ALICE")
        assert found2 is not None

    def test_find_node_by_label_returns_none_when_missing(self, graph):
        assert graph.find_node_by_label("Nobody") is None

    def test_create_node_with_observation(self, graph):
        node = graph.create_node("Alice", "person", observation="She likes dogs")
        fetched = graph.get_node(node["id"])
        import json
        obs = json.loads(fetched["raw_observations"])
        assert obs == ["She likes dogs"]

    def test_create_node_without_observation(self, graph):
        node = graph.create_node("Alice", "person")
        fetched = graph.get_node(node["id"])
        import json
        obs = json.loads(fetched["raw_observations"])
        assert obs == []


class TestNodeReinforce:
    def test_reinforce_adds_weight(self, graph):
        node = graph.create_node("Alice", "person", weight=0.10)
        updated = graph.reinforce_node(node["id"], 0.50)
        assert updated["weight"] == pytest.approx(0.60, abs=0.01)

    def test_reinforce_updates_tier(self, graph):
        node = graph.create_node("Alice", "person", weight=0.10)
        assert node["tier"] == "ephemeral"
        updated = graph.reinforce_node(node["id"], 3.0)
        assert updated["tier"] == "significant"

    def test_reinforce_nonexistent_returns_none(self, graph):
        result = graph.reinforce_node("nonexistent-id", 1.0)
        assert result is None


class TestNodeObservation:
    def test_add_observation_appends(self, graph):
        import json
        node = graph.create_node("Alice", "person", observation="Obs 1")
        graph.add_observation(node["id"], "Obs 2")
        fetched = graph.get_node(node["id"])
        obs = json.loads(fetched["raw_observations"])
        assert obs == ["Obs 1", "Obs 2"]

    def test_add_observation_to_nonexistent_returns_none(self, graph):
        assert graph.add_observation("nonexistent", "test") is None


class TestIdentityRelevance:
    def test_set_identity_relevance(self, graph):
        node = graph.create_node("Alice", "person")
        graph.set_identity_relevance(node["id"], "self")
        fetched = graph.get_node(node["id"])
        assert fetched["identity_relevance"] == "self"

    def test_reject_invalid_relevance(self, graph):
        node = graph.create_node("Alice", "person")
        graph.set_identity_relevance(node["id"], "invalid")
        fetched = graph.get_node(node["id"])
        assert fetched["identity_relevance"] == "neutral"

    def test_school_node_cannot_be_downgraded_to_neutral(self, graph):
        node = graph.create_node("Conviction", "concept", identity_relevance="self", provenance="school")
        graph.set_identity_relevance(node["id"], "neutral")
        fetched = graph.get_node(node["id"])
        assert fetched["identity_relevance"] == "self"  # Unchanged

    def test_school_node_can_be_upgraded(self, graph):
        node = graph.create_node("Conviction", "concept", identity_relevance="self", provenance="school")
        graph.set_identity_relevance(node["id"], "relational")
        fetched = graph.get_node(node["id"])
        assert fetched["identity_relevance"] == "relational"


class TestDeleteNode:
    def test_delete_conversation_node(self, graph):
        node = graph.create_node("Alice", "person")
        graph.delete_node(node["id"])
        assert graph.get_node(node["id"]) is None

    def test_cannot_delete_school_node(self, graph):
        node = graph.create_node("Conviction", "concept", provenance="school")
        graph.delete_node(node["id"])
        assert graph.get_node(node["id"]) is not None

    def test_delete_removes_edges(self, graph):
        n1 = graph.create_node("Alice", "person")
        n2 = graph.create_node("Bob", "person")
        edge = graph.create_edge(n1["id"], n2["id"])
        graph.delete_node(n1["id"])
        assert graph.get_edge(edge["id"]) is None


class TestFindOrCreate:
    def test_creates_new_when_not_found(self, graph):
        node, created = graph.find_or_create_node("Alice", "person")
        assert created is True
        assert node["label"] == "Alice"

    def test_finds_existing_and_reinforces(self, graph):
        graph.create_node("Alice", "person", weight=0.10)
        node, created = graph.find_or_create_node("Alice", "person", weight=0.50)
        assert created is False
        assert node["weight"] > 0.10

    def test_identity_relevance_upgrade_neutral_to_self(self, graph):
        graph.create_node("Topic", "concept", identity_relevance="neutral")
        node, _ = graph.find_or_create_node("Topic", "concept", identity_relevance="self")
        assert node["identity_relevance"] == "self"

    def test_identity_relevance_upgrade_self_plus_user_to_relational(self, graph):
        graph.create_node("Topic", "concept", identity_relevance="self")
        node, _ = graph.find_or_create_node("Topic", "concept", identity_relevance="user")
        assert node["identity_relevance"] == "relational"


# ── Edge CRUD ────────────────────────────────────────────────────────────────

class TestEdgeCRUD:
    def test_create_and_get_edge(self, graph):
        n1 = graph.create_node("A", "concept")
        n2 = graph.create_node("B", "concept")
        edge = graph.create_edge(n1["id"], n2["id"])
        assert edge["from_node_id"] == n1["id"]
        assert edge["to_node_id"] == n2["id"]
        fetched = graph.get_edge(edge["id"])
        assert fetched is not None

    def test_duplicate_edge_reinforces(self, graph):
        n1 = graph.create_node("A", "concept")
        n2 = graph.create_node("B", "concept")
        e1 = graph.create_edge(n1["id"], n2["id"], weight=0.10)
        e2 = graph.create_edge(n1["id"], n2["id"], weight=0.20)
        # Should be the same edge, reinforced
        assert e2["id"] == e1["id"]
        assert e2["weight"] > 0.10

    def test_undirected_edge_detection(self, graph):
        n1 = graph.create_node("A", "concept")
        n2 = graph.create_node("B", "concept")
        graph.create_edge(n1["id"], n2["id"])
        # Creating reverse direction should find existing
        edge = graph.get_edge_between(n2["id"], n1["id"])
        assert edge is not None

    def test_get_edges_from(self, graph):
        n1 = graph.create_node("A", "concept")
        n2 = graph.create_node("B", "concept")
        n3 = graph.create_node("C", "concept")
        graph.create_edge(n1["id"], n2["id"])
        graph.create_edge(n1["id"], n3["id"])
        edges = graph.get_edges_from(n1["id"])
        assert len(edges) == 2

    def test_delete_edge(self, graph):
        n1 = graph.create_node("A", "concept")
        n2 = graph.create_node("B", "concept")
        edge = graph.create_edge(n1["id"], n2["id"])
        graph.delete_edge(edge["id"])
        assert graph.get_edge(edge["id"]) is None


# ── Ripple Propagation ───────────────────────────────────────────────────────

class TestRipple:
    def test_ripple_propagates_to_parent(self, graph):
        n1 = graph.create_node("Child", "concept", weight=0.10)
        n2 = graph.create_node("Parent", "concept", weight=0.10)
        graph.create_edge(n1["id"], n2["id"])
        graph.apply_ripple(n1["id"], 1.0)
        parent = graph.get_node(n2["id"])
        # Parent should have received some weight
        assert parent["weight"] > 0.10

    def test_ripple_skipped_for_tiny_weight(self, graph):
        n1 = graph.create_node("A", "concept", weight=0.10)
        n2 = graph.create_node("B", "concept", weight=0.10)
        graph.create_edge(n1["id"], n2["id"])
        # Very small weight → parent share < 0.001 → no ripple
        graph.apply_ripple(n1["id"], 0.001)
        parent = graph.get_node(n2["id"])
        assert parent["weight"] == pytest.approx(0.10, abs=0.01)


# ── L1 / L2 / L3 / Short-term ───────────────────────────────────────────────

class TestL1:
    def test_store_and_retrieve_l1(self, graph):
        graph.store_l1("Hello world", "session-1")
        uncondensed = graph.get_uncondensed_l1()
        assert len(uncondensed) == 1
        assert uncondensed[0]["content"] == "Hello world"
        assert uncondensed[0]["session_id"] == "session-1"

    def test_l1_char_count(self, graph):
        graph.store_l1("Hello", "s1")
        graph.store_l1("World!", "s1")
        count = graph.get_uncondensed_l1_char_count()
        assert count == len("Hello") + len("World!")

    def test_mark_l1_condensed(self, graph):
        graph.store_l1("test", "s1")
        uncondensed = graph.get_uncondensed_l1()
        assert len(uncondensed) == 1
        ids = [r["id"] for r in uncondensed]
        graph.mark_l1_condensed(ids)
        assert len(graph.get_uncondensed_l1()) == 0


class TestL2:
    def test_store_and_retrieve_l2(self, graph):
        node = graph.create_node("Alice", "person")
        graph.store_l2(node["id"], "She mentioned her dog")
        recent = graph.get_recent_l2(limit=10)
        assert len(recent) == 1
        assert recent[0]["observation"] == "She mentioned her dog"

    def test_uncondensed_l2(self, graph):
        node = graph.create_node("Alice", "person")
        graph.store_l2(node["id"], "Obs 1")
        graph.store_l2(node["id"], "Obs 2")
        uncondensed = graph.get_uncondensed_l2()
        assert len(uncondensed) == 2

    def test_mark_l2_condensed(self, graph):
        node = graph.create_node("Alice", "person")
        graph.store_l2(node["id"], "Obs 1")
        uncondensed = graph.get_uncondensed_l2()
        ids = [r["id"] for r in uncondensed]
        graph.mark_l2_condensed(ids)
        assert len(graph.get_uncondensed_l2()) == 0


class TestL3:
    def test_portrait_initially_has_no_content(self, graph):
        portrait = graph.get_l3_portrait()
        # Row exists from schema init but content is NULL
        assert portrait is not None
        assert portrait["content"] is None

    def test_update_and_get_portrait(self, graph):
        graph.update_l3_portrait("Alice is kind")
        portrait = graph.get_l3_portrait()
        assert portrait["content"] == "Alice is kind"
        assert portrait["word_count"] == 3

    def test_self_portrait_initially_has_no_content(self, graph):
        portrait = graph.get_l3_self_portrait()
        assert portrait is not None
        assert portrait["content"] is None

    def test_update_and_get_self_portrait(self, graph):
        graph.update_l3_self_portrait("I learn from Alice")
        portrait = graph.get_l3_self_portrait()
        assert portrait["content"] == "I learn from Alice"
        assert portrait["word_count"] == 4


class TestShortTerm:
    def test_store_and_get_short_term(self, graph):
        graph.store_short_term("s1", "user", "Hi there")
        graph.store_short_term("s1", "bot", "Hello!")
        messages = graph.get_short_term("s1")
        assert len(messages) == 2
        assert messages[0]["role"] == "user"
        assert messages[1]["role"] == "bot"

    def test_clear_short_term(self, graph):
        graph.store_short_term("s1", "user", "Hi")
        graph.clear_short_term("s1")
        assert len(graph.get_short_term("s1")) == 0


# ── Conviction Logging ───────────────────────────────────────────────────────

class TestConvictions:
    def test_log_and_get_conviction_stats(self, graph):
        graph.log_conviction_reinforcement("Topic A", "School conviction text", 1.5)
        graph.log_conviction_reinforcement("Topic A", "School conviction text", 2.0)
        stats = graph.get_conviction_stats()
        assert len(stats) > 0
        topic_a = [s for s in stats if s["school_conviction"] == "School conviction text"]
        assert len(topic_a) == 1
        assert topic_a[0]["fire_count"] == 2
        assert topic_a[0]["total_weight"] == pytest.approx(3.5)


# ── Self Observations ────────────────────────────────────────────────────────

class TestSelfObservations:
    def test_store_and_get_self_observations(self, graph):
        graph.store_self_observation("I noticed I tend to hedge")
        graph.store_self_observation("I build rapport through questions")
        obs = graph.get_uncondensed_self_observations()
        assert len(obs) == 2

    def test_mark_self_observations_condensed(self, graph):
        graph.store_self_observation("Observation 1")
        uncondensed = graph.get_uncondensed_self_observations()
        ids = [o["id"] for o in uncondensed]
        graph.mark_self_observations_condensed(ids)
        assert len(graph.get_uncondensed_self_observations()) == 0

    def test_get_recent_self_observations(self, graph):
        graph.store_self_observation("Obs 1")
        graph.store_self_observation("Obs 2")
        recent = graph.get_recent_self_observations(limit=1)
        assert len(recent) == 1


# ── Active nodes ─────────────────────────────────────────────────────────────

class TestActiveNodes:
    def test_get_active_nodes_respects_min_weight(self, graph):
        graph.create_node("Heavy", "concept", weight=5.0)
        graph.create_node("Light", "concept", weight=0.01)
        active = graph.get_active_nodes(min_weight=1.0)
        assert len(active) == 1
        assert active[0]["label"] == "Heavy"

    def test_get_all_nodes(self, graph):
        graph.create_node("A", "concept")
        graph.create_node("B", "concept")
        all_nodes = graph.get_all_nodes()
        assert len(all_nodes) == 2
