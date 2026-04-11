"""
Community Actions Mixin — pre-action community work.

Extracted from agent.py for file size management. These methods are
mixed into PeerZeroBot via multiple inheritance.

These run BEFORE the main action each cycle. They are lightweight
community participation tasks (rating reviews, red team, open questions)
that use the fast model and don't block the productive loop.
"""

import random
import logging

from .adapters.school import extract_json

logger = logging.getLogger("peerzero-bot")


class CommunityActionsMixin:
    """Community participation methods (rate reviews, red team, open questions)."""

    _rated_review_ids: set = None  # in-memory cache of review IDs we've already rated

    def _do_rate_reviews(self, system_prompt, profile: dict):
        """Rate other agents' reviews on papers we also reviewed."""
        if self._rated_review_ids is None:
            self._rated_review_ids = set()

        # Use papers we've reviewed recently from tracked IDs
        tracked_ids = self.memory.get_tracked_review_ids()
        if not tracked_ids:
            return

        _VALID_TAGS = {"identified_error", "statistical_misuse", "overclaim",
                       "poor_uncertainty", "missing_control", "logical_gap",
                       "vague", "consensus_following"}

        for paper_id in list(tracked_ids)[:3]:
            try:
                full = self.school.get_papers(params={"id": paper_id})
                reviews = []
                if isinstance(full, dict):
                    reviews = full.get("reviews", [])
                elif isinstance(full, list) and full:
                    reviews = full[0].get("reviews", []) if isinstance(full[0], dict) else []
            except Exception as e:
                logger.debug(f"[RATE] Failed to fetch paper {paper_id}: {e}")
                continue

            # Extract bot's own review for context (so LLM knows what we thought)
            own_review = None
            for r in reviews:
                if r.get("reviewer_handle") == self.config.handle:
                    own_review = r
                    break

            for review in reviews[:3]:
                review_id = review.get("id")
                if not review_id or review.get("reviewer_handle") == self.config.handle:
                    continue
                if not review.get("overall_assessment"):
                    continue
                if review_id in self._rated_review_ids:
                    continue  # skip — already rated (or attempted) this session

                try:
                    rate_skill = self.school.download_skill_action("rate_review")
                    user_msg = self.prompts.build_review_rating_prompt(review, action_skill=rate_skill, own_review=own_review)
                    response = self.llm_fast.call_best_effort(system_prompt, user_msg)
                    if not response:
                        continue
                    rating = extract_json(response)
                    if not rating or "helpful" not in rating:
                        continue
                    tags = [t for t in rating.get("tags", []) if t in _VALID_TAGS]
                    self.school.submit_review_rating(review_id, rating["helpful"], tags)
                    self._rated_review_ids.add(review_id)
                    logger.info(f"[RATE] Rated review {review_id}: helpful={rating['helpful']}")
                except Exception as e:
                    status = getattr(getattr(e, "response", None), "status_code", None)
                    if status == 409:
                        self._rated_review_ids.add(review_id)  # don't retry
                        continue
                    if status == 403:
                        # We didn't actually review this paper — remove stale tracking
                        logger.info(f"[RATE] 403 on paper {paper_id} — removing stale tracked ID")
                        self.memory.remove_tracked_review_id(paper_id)
                        break  # skip remaining reviews on this paper
                    logger.debug(f"[RATE] Failed to rate review: {e}")

    def _do_red_team_responses(self, system_prompt):
        """File red team interrogations on bounties against our papers."""
        try:
            my_papers = self.school.get_my_papers()
        except Exception as e:
            logger.debug(f"[RED_TEAM] Failed to fetch my papers: {e}")
            return

        originals = [p for p in my_papers if not p.get("parent_paper_id")]
        for paper in originals[:5]:
            paper_id = paper.get("id")
            if not paper_id:
                continue

            try:
                bounties = self.school.get_bounties(params={"paper_id": paper_id})
            except Exception as e:
                logger.debug(f"[COMMUNITY] Failed to fetch bounties for paper {paper_id}: {e}")
                continue

            for b in (bounties if isinstance(bounties, list) else []):
                if b.get("status") != "pending":
                    continue
                for src in (b.get("external_sources") or [])[:2]:
                    if src.get("red_team_response"):
                        continue
                    doi = src.get("doi", "")
                    finding = src.get("specific_finding", "")
                    bridge = src.get("logical_bridge", "")
                    if not doi or not finding:
                        continue

                    try:
                        rt_skill = self.school.download_skill_action("red_team")
                        user_msg = self.prompts.build_red_team_prompt(doi, finding, bridge, action_skill=rt_skill)
                        interrogation = self.llm_fast.call_best_effort(system_prompt, user_msg)
                        if not interrogation or len(interrogation.strip()) < 80:
                            continue
                        self.school.submit_red_team(b["id"], doi, interrogation.strip())
                        logger.info(f"[RED_TEAM] Filed interrogation for bounty {b['id']}")
                    except Exception as e:
                        logger.warning(f"[RED_TEAM] Failed for bounty {b['id']}: {e}")

    def _do_red_team_jury_vote(self, system_prompt):
        """Vote on red team responses for papers we reviewed."""
        tracked_ids = self.memory.get_tracked_review_ids()
        if not tracked_ids:
            return

        for paper_id in list(tracked_ids)[:5]:
            try:
                bounties = self.school.get_bounties(params={"paper_id": paper_id})
            except Exception as e:
                logger.debug(f"[COMMUNITY] Failed to fetch bounties for paper {paper_id}: {e}")
                continue

            for b in (bounties if isinstance(bounties, list) else []):
                for src in (b.get("external_sources") or []):
                    rt = src.get("red_team_response")
                    if not rt or rt.get("resolved") or rt.get("my_vote"):
                        continue

                    finding = src.get("specific_finding", "")
                    bridge = src.get("logical_bridge", "")
                    interrogation = rt.get("interrogation", "")
                    if not interrogation:
                        continue

                    try:
                        vote_skill = self.school.download_skill_action("red_team")
                        user_msg = self.prompts.build_red_team_vote_prompt(finding, bridge, interrogation, action_skill=vote_skill)
                        response = self.llm_fast.call_best_effort(system_prompt, user_msg)
                        if not response:
                            continue
                        vote_data = extract_json(response)
                        if not vote_data or "vote" not in vote_data:
                            continue
                        vote = vote_data["vote"]
                        reasoning = str(vote_data.get("reasoning", ""))
                        if vote not in ("upheld", "rejected") or len(reasoning) < 100:
                            continue
                        self.school.vote_red_team(rt.get("id", ""), vote, reasoning)
                        logger.info(f"[JURY] Voted {vote} on red team response")
                        return  # one vote per cycle
                    except Exception as e:
                        logger.debug(f"[JURY] Failed: {e}")

    def _do_open_questions(self, system_prompt):
        """Vote on open questions and occasionally post new ones."""
        try:
            questions = self.school.get_open_questions()
        except Exception as e:
            logger.debug(f"[OPEN_Q] Failed to fetch open questions: {e}")
            return

        # Vote on well-formed questions (one per cycle)
        for q in (questions if isinstance(questions, list) else [])[:5]:
            if q.get("my_vote"):
                continue
            title = q.get("title", "")
            desc = q.get("description", "")
            if len(title) > 30 and len(desc) > 100:
                try:
                    self.school.vote_open_question(q["id"])
                    logger.info(f"[QUESTIONS] Voted on: {title[:50]}...")
                    break
                except Exception as e:
                    logger.debug(f"[QUESTIONS] Vote failed: {e}")

        # 10% chance to post a new question
        if random.random() < 0.1 and len(questions) < 50:
            try:
                user_msg = self.school.download_skill_action("open_question")
                response = self.llm_fast.call_best_effort(system_prompt, user_msg)
                if not response:
                    return
                q_data = extract_json(response)
                if q_data and q_data.get("title") and q_data.get("description"):
                    self.school.submit_open_question(q_data)
                    logger.info(f"[QUESTIONS] Posted: {q_data['title'][:50]}...")
            except Exception as e:
                logger.debug(f"[QUESTIONS] Post failed: {e}")

    def _do_structural_bounties(self, system_prompt, profile: dict):
        """File structural bounties (no_mechanism_chain, weak_source_quality) on bountyable papers."""
        bountyable = profile.get("bountyable_papers", [])
        if not bountyable:
            return

        for paper in bountyable[:5]:
            # No mechanism chain bounty — purely structural, no LLM needed
            if paper.get("missing_mechanism_chain"):
                try:
                    self.school.submit_bounty({
                        "action": "register",
                        "target_paper_id": paper["id"],
                        "challenge_type": "no_mechanism_chain",
                    })
                    logger.info(f"[BOUNTY] Filed no_mechanism_chain on {paper['id']}")
                    return  # one structural bounty per cycle
                except Exception as e:
                    status = getattr(getattr(e, "response", None), "status_code", None)
                    if status == 409:
                        continue
                    logger.debug(f"[BOUNTY] Structural bounty failed: {e}")
