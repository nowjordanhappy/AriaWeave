# Fixtures

Synthetic pages with planted, countable accessibility failures. Each one exists
for a reason recorded in `expectations.json` and in a comment at the top of the
file — if a fixture's purpose is not obvious, that is a bug in the fixture.

## Still missing: real snapshots

`expectations.json` covers the synthetic corpus only. The spec's definition of
done also requires a live run against a real Peruvian government page, captured
here as a snapshot so the harness stays deterministic.

To add one:

1. Save the page complete (HTML + assets) into `tests/fixtures/real/<name>/`.
2. Strip analytics and third-party scripts — the harness must not hit the network.
3. Add an entry to `expectations.json` with reference descriptions written by a
   human. **Do not generate the references with the same pipeline under test**;
   that makes the similarity criterion circular and it will pass while being
   worthless.

Not faked in advance. A synthetic page pretending to be gob.pe would prove
nothing and would be found out in the demo.
