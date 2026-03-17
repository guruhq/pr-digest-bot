# PR Digest Bot

A GitHub Action that posts a daily digest of open pull requests to Slack. Uses Claude to generate one-line summaries and review effort estimates for each PR.

## How it works

Runs on weekdays at ~9am ET. Fetches open PRs, filters and categorizes them, then posts a formatted digest to Slack.

### Categories (priority order, deduplicated)
1. **Re-review Ready** — Changes were requested and the author has updated the PR
2. **Needs Eyes** — Reviewers assigned but no substantive reviews yet
3. **Quick Win** — Small diff (<100 lines), fast to review

### Filters
- Excludes draft PRs
- Excludes bot authors (dependabot, renovate, etc.)
- Excludes approved PRs
- Excludes PRs with no reviewers assigned
- Only includes PRs from the last 3 weeks
- Caps at 10 PRs

## Setup

### 1. Configure the workflow

Edit `.github/workflows/pr-digest.yml` and set:

```yaml
env:
  TARGET_REPO: your-org/your-repo   # repo to monitor
  LOOKBACK_DAYS: "21"               # how far back to look
  MAX_PRS: "10"                     # max PRs in digest
  BOT_USERS: "dependabot[bot],renovate[bot]"  # comma-separated bot usernames to exclude
```

### 2. Add secrets

In your repo settings → Secrets and variables → Actions, add:

| Secret | Description |
|--------|-------------|
| `GH_PAT` | GitHub Personal Access Token with `repo` read access to the target repo |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook URL for your channel |
| `ANTHROPIC_API_KEY` | Claude API key for PR summaries |

### 3. Create a Slack webhook

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Create or select an app
3. Enable **Incoming Webhooks**
4. Add a webhook to your desired channel
5. Copy the webhook URL

### 4. Create a GitHub PAT

1. Go to GitHub → Settings → Developer settings → Personal access tokens
2. Create a fine-grained token with **read access** to pull requests and contents for the target repo
3. Copy the token

### 5. Test it

Trigger the workflow manually from the Actions tab using the "Run workflow" button.

## Customization

- **Schedule**: Edit the cron expression in the workflow file. Use [crontab.guru](https://crontab.guru/) to help. Remember cron is in UTC.
- **Quick Win threshold**: Change the `100` line threshold in `src/index.mjs`
- **Claude model**: Change the model in `src/index.mjs` (default: `claude-sonnet-4-20250514`)
