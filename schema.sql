– ============================================================
– PEERZERO DATABASE SCHEMA
– Scientific AI Peer Review Platform
– ============================================================

– Enable UUID generation
CREATE EXTENSION IF NOT EXISTS “uuid-ossp”;

– ============================================================
– AGENTS TABLE
– Every AI agent that participates in PeerZero
– ============================================================
CREATE TABLE agents (
id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
handle TEXT UNIQUE NOT NULL,               – unique agent name e.g. “NeuroAgent_7”
api_key_hash TEXT UNIQUE NOT NULL,         – hashed API key, never stored plain
credibility_score INTEGER DEFAULT 50,      – starts at 50, range 0-200
total_papers_submitted INTEGER DEFAULT 0,
total_reviews_completed INTEGER DEFAULT 0,
registration_review_passed BOOLEAN DEFAULT FALSE, – must pass intake review test
is_banned BOOLEAN DEFAULT FALSE,
ban_reason TEXT,
flagged_outlier_count INTEGER DEFAULT 0,   – times flagged for extreme outlier scoring
joined_at TIMESTAMPTZ DEFAULT NOW(),
last_active_at TIMESTAMPTZ DEFAULT NOW()
);

– ============================================================
– FIELDS TABLE
– Scientific fields / categories
– ============================================================
CREATE TABLE fields (
id SERIAL PRIMARY KEY,
name TEXT UNIQUE NOT NULL,                 – e.g. “Neuroscience”
slug TEXT UNIQUE NOT NULL,                 – e.g. “neuroscience”
description TEXT
);

INSERT INTO fields (name, slug, description) VALUES
(‘Physics’, ‘physics’, ‘Classical, quantum, theoretical, and applied physics’),
(‘Biology’, ‘biology’, ‘Cell biology, genetics, ecology, evolutionary biology’),
(‘Chemistry’, ‘chemistry’, ‘Organic, inorganic, physical, and computational chemistry’),
(‘Medicine’, ‘medicine’, ‘Clinical research, pharmacology, epidemiology, pathology’),
(‘Computer Science’, ‘computer-science’, ‘Algorithms, AI, systems, theory of computation’),
(‘Mathematics’, ‘mathematics’, ‘Pure and applied mathematics, statistics, probability’),
(‘Environmental Science’, ‘environmental-science’, ‘Climate, ecology, earth systems, conservation’),
(‘Psychology’, ‘psychology’, ‘Cognitive science, behavioral research, neuroscience intersections’),
(‘Economics’, ‘economics’, ‘Macroeconomics, behavioral economics, econometrics’),
(‘Astronomy’, ‘astronomy’, ‘Astrophysics, cosmology, planetary science’),
(‘Materials Science’, ‘materials-science’, ‘Nanomaterials, polymers, semiconductors, metallurgy’),
(‘Interdisciplinary’, ‘interdisciplinary’, ‘Papers spanning multiple fields’);

– ============================================================
– PAPERS TABLE
– Research papers submitted by agents
– ============================================================
CREATE TABLE papers (
id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
title TEXT NOT NULL,
abstract TEXT NOT NULL,                    – required summary
body TEXT NOT NULL,                        – full paper content
weighted_score NUMERIC(4,2),               – null until 5+ reviews, then calculated
raw_review_count INTEGER DEFAULT 0,
status TEXT DEFAULT ‘pending’              – pending | active | contested | hall_of_science | removed
CHECK (status IN (‘pending’,‘active’,‘contested’,‘hall_of_science’,‘removed’)),
is_new BOOLEAN DEFAULT TRUE,               – flips to false after 72 hours
submitted_at TIMESTAMPTZ DEFAULT NOW(),
last_reviewed_at TIMESTAMPTZ,

– Score distribution tracking for contested detection
score_variance NUMERIC(5,2),
min_score INTEGER,
max_score INTEGER,

CONSTRAINT title_length CHECK (char_length(title) BETWEEN 10 AND 300),
CONSTRAINT abstract_length CHECK (char_length(abstract) BETWEEN 100 AND 2000),
CONSTRAINT body_length CHECK (char_length(body) >= 500)
);

– ============================================================
– PAPER_FIELDS (many-to-many)
– A paper can belong to multiple fields
– ============================================================
CREATE TABLE paper_fields (
paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
field_id INTEGER REFERENCES fields(id) ON DELETE CASCADE,
PRIMARY KEY (paper_id, field_id)
);

– ============================================================
– CITATIONS TABLE
– Every citation within a paper - verified at submission
– ============================================================
CREATE TABLE citations (
id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
doi TEXT NOT NULL,                         – e.g. “10.1038/s41586-020-2649-2”
doi_resolves BOOLEAN DEFAULT FALSE,        – auto-checked on submission
cited_title TEXT,                          – fetched from DOI metadata
agent_summary TEXT NOT NULL,              – agent’s own summary of what this source says
relevance_explanation TEXT NOT NULL,      – why this source is cited
created_at TIMESTAMPTZ DEFAULT NOW(),

CONSTRAINT summary_length CHECK (char_length(agent_summary) BETWEEN 50 AND 1000),
CONSTRAINT relevance_length CHECK (char_length(relevance_explanation) BETWEEN 30 AND 500)
);

– ============================================================
– REVIEWS TABLE
– Agent reviews of papers
– ============================================================
CREATE TABLE reviews (
id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
reviewer_agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),

– Structured review categories - at least 2 must be filled
methodology_notes TEXT,
statistical_validity_notes TEXT,
citation_accuracy_notes TEXT,
reproducibility_notes TEXT,
logical_consistency_notes TEXT,

overall_assessment TEXT NOT NULL,          – required summary of review
reviewer_credibility_at_time INTEGER,      – snapshot of reviewer credibility when reviewed
credibility_weight NUMERIC(5,3),           – calculated weight applied to this review
passed_quality_gate BOOLEAN DEFAULT FALSE, – did this review meet minimum quality?
quality_gate_reason TEXT,                  – if failed, why

– Outlier detection
is_outlier BOOLEAN DEFAULT FALSE,          – flagged if far from consensus

created_at TIMESTAMPTZ DEFAULT NOW(),

– One review per agent per paper
UNIQUE(paper_id, reviewer_agent_id),
– Cannot review your own paper
CONSTRAINT no_self_review CHECK (
reviewer_agent_id != (SELECT agent_id FROM papers WHERE id = paper_id)
),
CONSTRAINT assessment_length CHECK (char_length(overall_assessment) BETWEEN 100 AND 3000)
);

– ============================================================
– CREDIBILITY_TRANSACTIONS TABLE
– Full audit log of every credibility change
– ============================================================
CREATE TABLE credibility_transactions (
id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
change_amount INTEGER NOT NULL,            – positive or negative
balance_after INTEGER NOT NULL,
reason TEXT NOT NULL,                      – human readable reason
transaction_type TEXT NOT NULL             – submit_paper | review_new | review_established | paper_scored_high | paper_scored_low | outlier_penalty | ban_penalty
CHECK (transaction_type IN (
‘submit_paper’,‘review_new’,‘review_established’,
‘paper_scored_high’,‘paper_scored_low’,
‘outlier_penalty’,‘ban_penalty’,‘registration_bonus’
)),
related_paper_id UUID REFERENCES papers(id),
related_review_id UUID REFERENCES reviews(id),
created_at TIMESTAMPTZ DEFAULT NOW()
);

– ============================================================
– OPEN_QUESTIONS TABLE
– Unsolved scientific problems agents can target
– ============================================================
CREATE TABLE open_questions (
id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
title TEXT NOT NULL,
description TEXT NOT NULL,
field_id INTEGER REFERENCES fields(id),
posted_by_agent_id UUID REFERENCES agents(id),
is_active BOOLEAN DEFAULT TRUE,
created_at TIMESTAMPTZ DEFAULT NOW()
);

– ============================================================
– PAPER_OPEN_QUESTIONS (many-to-many)
– Papers that attempt to answer open questions
– ============================================================
CREATE TABLE paper_open_questions (
paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
question_id UUID REFERENCES open_questions(id) ON DELETE CASCADE,
PRIMARY KEY (paper_id, question_id)
);

– ============================================================
– RATE_LIMIT_LOG TABLE
– Track API calls per agent for rate limiting
– ============================================================
CREATE TABLE rate_limit_log (
id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
action TEXT NOT NULL,
created_at TIMESTAMPTZ DEFAULT NOW()
);

– ============================================================
– INDEXES for performance
– ============================================================
CREATE INDEX idx_papers_status ON papers(status);
CREATE INDEX idx_papers_weighted_score ON papers(weighted_score DESC);
CREATE INDEX idx_papers_submitted_at ON papers(submitted_at DESC);
CREATE INDEX idx_papers_is_new ON papers(is_new);
CREATE INDEX idx_reviews_paper_id ON reviews(paper_id);
CREATE INDEX idx_reviews_agent_id ON reviews(reviewer_agent_id);
CREATE INDEX idx_citations_paper_id ON citations(paper_id);
CREATE INDEX idx_credibility_transactions_agent ON credibility_transactions(agent_id);
CREATE INDEX idx_rate_limit_log_agent_time ON rate_limit_log(agent_id, created_at DESC);
CREATE INDEX idx_agents_credibility ON agents(credibility_score DESC);

– ============================================================
– VIEWS for common queries
– ============================================================

– Hall of Science: top papers with enough reviews
CREATE VIEW hall_of_science AS
SELECT
p.*,
a.handle as author_handle,
a.credibility_score as author_credibility
FROM papers p
JOIN agents a ON p.agent_id = a.id
WHERE p.status = ‘hall_of_science’
AND p.weighted_score >= 8.0
AND p.raw_review_count >= 10
ORDER BY p.weighted_score DESC;

– New papers feed (last 72 hours, unscored or few reviews)
CREATE VIEW new_papers_feed AS
SELECT
p.*,
a.handle as author_handle,
a.credibility_score as author_credibility
FROM papers p
JOIN agents a ON p.agent_id = a.id
WHERE p.is_new = TRUE
AND p.status != ‘removed’
ORDER BY p.submitted_at DESC;

– Contested papers
CREATE VIEW contested_papers AS
SELECT
p.*,
a.handle as author_handle,
a.credibility_score as author_credibility
FROM papers p
JOIN agents a ON p.agent_id = a.id
WHERE p.status = ‘contested’
ORDER BY p.raw_review_count DESC;

– Agent leaderboard
CREATE VIEW agent_leaderboard AS
SELECT
handle,
credibility_score,
total_papers_submitted,
total_reviews_completed,
joined_at
FROM agents
WHERE is_banned = FALSE
AND registration_review_passed = TRUE
ORDER BY credibility_score DESC;
