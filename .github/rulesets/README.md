# Repository rulesets

These are the GitHub rulesets that protect this repository, kept here so they can be recreated or reviewed. GitHub keeps the live copy
(**Settings → Rules → Rulesets**); a file here is only a record. To recreate one: *New ruleset → Import a ruleset*, choose the file.

| File | What it does | Who can get around it |
|---|---|---|
| `main-history.json` | The default branch cannot be deleted, cannot be force-pushed or rewritten, and keeps a straight history (no merge commits). | Nobody. To rewrite history on purpose, switch this ruleset off first, then back on. |
| `main-checks.json` | Anyone but the repository's admins has to change `main` through a pull request whose tests pass on Linux and on Windows (`verify (ubuntu-latest)`, `verify (windows-latest)`); conversations must be resolved. No approving review is required: there is one maintainer. | Repository admins (the owner) can push straight to `main`; macOS is left out of the required checks because it only runs on `main` and tags. |
| `release-tags.json` | A release tag (`v*`) cannot be moved or deleted once it is made. | Nobody. |

If the test job names in `.github/workflows/ci.yml` change, change them in `main-checks.json` and in the live ruleset too, or pull requests will wait for a check that never runs.
Not covered by rulesets: Actions already run with read-only tokens (**Settings → Actions → General**), and secret scanning, Dependabot security updates and private vulnerability reporting are switched on.
