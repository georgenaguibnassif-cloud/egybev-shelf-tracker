# Project Instructions

## Git workflow rules
- Always run `git pull origin main` before starting any change, to make sure you're working from the latest state.
- After every change, commit it and push to `origin/main` — never leave changes committed locally only.
- After pushing, explicitly confirm back to the user:
  1. That the push succeeded (not just committed locally)
  2. The commit hash or a link to it
  3. That `git status` shows a clean working tree
- If the push fails for any reason (auth issue, merge conflict, etc.), state clearly what went wrong — never report success if it didn't actually push.
