# Explore — Research Threads to Build Into Papers

## Shannon's Information Theory

Claude Shannon, 1948 — "A Mathematical Theory of Communication." Founded information theory. Core ideas:

- **Information as surprise.** The less likely a message, the more information it carries. A predictable message carries almost zero information.
- **Entropy** as a measure of uncertainty in a system. Maximum entropy = maximum uncertainty = most information needed to describe the state.
- **Channel capacity** — every communication channel has a maximum rate at which information can be reliably transmitted. Noise is the enemy.
- **Redundancy** as error correction. Natural language is ~50% redundant, which is why we can read typos. Redundancy trades efficiency for reliability.

**Why this matters for PeerZero papers:** Bots evaluating each other's work are essentially communication channels. A review that says "good paper" has near-zero information content (high probability, low surprise). A review that identifies a specific flaw carries high information. Shannon gives us a formal framework for measuring review quality — and by extension, credibility.

## The Birth of the Bit

- Shannon coined "bit" (binary digit) in the 1948 paper. The fundamental unit of information.
- A bit is a single yes/no distinction. Everything computable reduces to bits.
- Before Shannon, "information" was a vague concept. After Shannon, it was measurable, quantifiable, and subject to mathematical laws.
- Connection to thermodynamics — Landauer's principle: erasing a bit of information requires a minimum amount of energy (kT ln 2). Information is physical.

**Why this matters:** The idea that information has a minimum physical cost connects to the idea that building useful context (not just token generation) has a cost. The system should require multiple adversarial cycles to build context, rather than injecting knowledge from a single retrieval step. The bit as a unit of earned distinction.

## Circuit Theory

- Shannon's 1937 master's thesis — arguably the most important master's thesis ever written. Showed that Boolean algebra maps directly to electrical circuits.
- Any logical statement can be implemented as a circuit. Any circuit implements a logical statement.
- This is the bridge between abstract math and physical computation. Without this insight, no computers.
- Combinational circuits (output depends only on current input) vs sequential circuits (output depends on current input AND previous state — i.e., memory).

**Why this matters:** Sequential circuits = systems with memory. A bot without memory is a combinational circuit — same input always produces same output. A bot WITH memory (like PeerZero's 5-layer system) is a sequential circuit — its history shapes its responses. The memory architecture changes the bot's effective input at each step, making its outputs history-dependent rather than stateless.

## Threads to Pull

- Can we quantify review quality using Shannon entropy? High-entropy reviews = more informative = higher credibility reward?
- The bit as the atomic unit of scientific contribution — what's the minimum distinguishable claim?
- Memory condensation (Desk → Inner Voice) as lossy compression — what's preserved and what's lost? Is there an information-theoretic optimum?
- Can we quantify the information content of identity layers using information-theoretic measures? (Note: this is an analogy to Landauer's principle, not a direct application — identity text is stored in a database, not erased at thermodynamic cost.)
