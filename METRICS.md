# Metrics

unerr measures what your coding agents spend and what their work produces. This
page defines every metric it computes, how each one is calculated, and what each
one leaves out.

Everything here is computed on your machine, from your own git history and your
own session records. None of it requires an account.

**These definitions are published under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).**
Use them, adapt them, argue with them. Attribution to unerr is all we ask. We
would rather the industry settle on shared definitions than have every tool
invent its own.

## Why these and not others

Most usage dashboards answer one question: how many tokens went out. That is a
spending number, and spending alone cannot tell you whether the spending was
worth it.

The metrics below split into two groups. Cost metrics describe what a session
spent and why. Outcome metrics describe whether the code produced stayed. You
need both to say anything useful. unerr computes both from data it already has,
so there is nothing for you to instrument.

## Outcome metrics

### Code survival

Of the lines added in the last 30 or 90 days, how many are still in your code
today, split by whether an agent or a human wrote them.

unerr lists the commits inside the window and sums the lines each one added. It
then runs `git blame` against your current checkout for every file touched in
that window, and counts how many blamed lines still point back at an in-window
commit. A commit counts as agent-authored when its message carries the
`Unerr-Session:` trailer, which unerr writes when an agent's work is committed.
Everything else counts as human.

The metric reports raw counts, not a percentage, so you can always see the
denominator.

**It does not measure** whether a change was reviewed, merged, or released, or
whether tests passed, or whether the surviving lines are any good. A line that
survives because nobody has opened that file counts the same as a line that
survives because it was right.

Treat it as a rate that moves over months, not a number to chase this week. A
wide gap between agent and human survival is worth understanding. A narrow one
usually just means both are being used on similar work.

Source: [`src/tracking/line-survival.ts`](./src/tracking/line-survival.ts)

### Durability score

Of the code entities an agent changed, the share whose bodies were still
untouched 24 hours later. The score runs from 0 to 1.

When an agent edits a function or class, unerr records a hash of that entity's
body. A day later it compares that hash against the current one. Unchanged
counts as survived, changed counts as reverted, and the score is survived
divided by the two together. Anything younger than 24 hours is still pending and
counts neither way. Below 0.5, with at least two recorded changes, unerr warns
the agent.

**It does not measure** why an entity changed again. A follow-up improvement and
a rollback look identical to a hash. The record also lives in the running
process rather than on disk, so a restart begins with an empty history.

Read it as a churn signal for one function, useful for finding the single place
an agent keeps rewriting. Code survival is the metric for project-level
questions.

Source: [`src/tracking/durability-tracker.ts`](./src/tracking/durability-tracker.ts)

## Cost metrics

These come from your local session records and describe how a conversation was
billed. They exist because the largest cost lever in an agent session is not the
model's price. It is whether the same text gets sent again on every turn.

### Cache hit rate

The share of a session's input served from the model's prompt cache instead of
being billed at full rate, expressed as a ratio from 0 to 1. unerr computes it
as cache reads divided by cache reads plus uncached input, summing the counters
your agent reports on each turn.

Higher is better. It means the front of the conversation stayed stable and got
reused.

**It does not measure** money. It is a ratio of tokens, and the price attached
to each kind of token varies by model and provider.

### Re-read amplification

How many times the average cached token was read back, computed as cache reads
divided by cache writes. A value of 35 means the typical cached token was billed
as a read 35 times.

This is the number that makes context expensive. Letting 500 tokens into a
conversation is not a 500-token decision. If the conversation runs long enough
to re-read them 35 times, it is a 17,500-token decision. That arithmetic is why
unerr is built to keep tokens out of context rather than compress them once
they are in.

**It does not measure** which tokens. It is a session-wide average, so it tells
you the multiplier applies without telling you what it applied to.

### Weighted input units

One number combining uncached input, cache reads, and cache writes at their
relative prices, so two sessions can be compared. Uncached input counts once, a
cache read counts as 0.1, and a cache write counts as 2 on the one-hour cache a
main conversation uses, or 1.25 on the five-minute cache.

**It does not measure** output tokens, which are excluded on purpose. They bill
on a different scale, and folding them in would hide which lever actually moved.

### Delegated share

What proportion of a session's work ran in a sub-agent rather than the main
conversation: sub-agent runs divided by sub-agent runs plus main-thread turns.

**It does not measure** whether delegating helped. It is a coarse proxy built
from counts unerr already has, not a judgment about quality.

Source for all four:
[`src/tracking/session-metrics.ts`](./src/tracking/session-metrics.ts) and
[`src/tracking/cost-economics-report.ts`](./src/tracking/cost-economics-report.ts)

## Self-correction patterns

Places where an agent queried a piece of code, edited it, then came straight
back to it, which usually means the first edit was wrong. unerr reports a count
per code entity and error type, each with a confidence score from 0 to 1, and
keeps the patterns scoring 0.6 or above.

It reads the local record of tool calls and looks for one shape: query an
entity, edit it, query the same entity again, all inside a sixty-second window
and within three steps. If another query of that entity follows the fix, the fix
is marked as having failed too. Confidence rises when the fix appears to have
worked and when the arguments match.

**It does not measure** a human fixing an agent's code. This is the agent
correcting itself inside one session, and it reports no timing. Read it as a
signal about which parts of your codebase agents struggle with, not as a rework
metric.

Source: [`src/tracking/correction-detector.ts`](./src/tracking/correction-detector.ts)

## What unerr does not measure

Being clear about the gaps matters as much as the metrics. Anyone can quote a
number. What it stays silent about is the harder question.

| Not measured | Why |
|---|---|
| Whether a change merged | unerr watches your local git history. It sees commits, not pull requests, so it cannot tell a merged change from an abandoned branch. |
| Whether tests passed | There is no test-runner integration. A metric that folded in test results would be inventing them. |
| Revert rate | No such metric exists. Code survival and durability are the shipped proxies, and both measure presence rather than intent. |
| Time saved | An honest version needs a counterfactual: what the same work would have cost with no agent. We do not have one. Any tool quoting you hours saved has guessed. |
| Individual developer performance | A design decision rather than a gap. See below. |

### No per-developer ranking, by design

Every metric here is defined for a repository or a session, never a person. Code
survival splits by whether an agent or a human wrote a line, not by which human.

This is not squeamishness. Survival and durability respond strongly to what kind
of work someone is doing. An engineer on a stable payments module will show high
survival. An engineer prototyping will show low survival, and should. Ranking
people on numbers that mostly encode their assignment produces a league table of
who got the safe work.

When shared team views arrive, they stay aggregate. That applies to the hosted
product too, not only to the local tool.

## Using the numbers yourself

The underlying records are yours and they sit in your repository. The format,
including how to read and export it, is documented in
[docs/DATA.md](./docs/DATA.md).

If you think a definition here is wrong,
[open an issue](https://github.com/unerr-ai/unerr/issues). A definition that has
survived an argument is worth more than one nobody challenged.
