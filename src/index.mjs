const GITHUB_API = "https://api.github.com";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

const [repoOwner, repoName] = (process.env.TARGET_REPO || "").split("/");

const config = {
  repoOwner,
  repoName,
  lookbackDays: parseInt(process.env.LOOKBACK_DAYS || "21"),
  maxPrs: parseInt(process.env.MAX_PRS || "10"),
  botUsers: new Set(
    (process.env.BOT_USERS || "")
      .split(",")
      .map((u) => u.trim().toLowerCase())
  ),
  ghToken: process.env.GH_PAT,
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
};

// --- GitHub API helpers ---

async function githubFetch(path) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${config.ghToken}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function fetchOpenPrs() {
  return githubFetch(
    `/repos/${config.repoOwner}/${config.repoName}/pulls?state=open&sort=created&direction=desc&per_page=100`
  );
}

async function fetchReviews(prNumber) {
  return githubFetch(
    `/repos/${config.repoOwner}/${config.repoName}/pulls/${prNumber}/reviews`
  );
}

async function fetchFiles(prNumber) {
  return githubFetch(
    `/repos/${config.repoOwner}/${config.repoName}/pulls/${prNumber}/files`
  );
}

async function fetchFirstReviewRequestDate(prNumber) {
  const res = await fetch(
    `${GITHUB_API}/repos/${config.repoOwner}/${config.repoName}/issues/${prNumber}/timeline?per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${config.ghToken}`,
        Accept: "application/vnd.github.mockingbird-preview+json",
      },
    }
  );
  if (!res.ok) return null;
  const events = await res.json();
  const reviewRequested = events.find((e) => e.event === "review_requested");
  return reviewRequested ? reviewRequested.created_at : null;
}

// --- Review state logic ---

function getReviewState(reviews) {
  const latestByReviewer = {};
  for (const review of reviews) {
    if (review.state === "COMMENTED") continue;
    const user = review.user.login;
    const prev = latestByReviewer[user];
    if (!prev || new Date(review.submitted_at) > new Date(prev.submitted_at)) {
      latestByReviewer[user] = review;
    }
  }

  const states = Object.values(latestByReviewer).map((r) => r.state);
  if (states.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  if (states.includes("APPROVED")) return "APPROVED";
  return "NONE";
}

// --- Date helpers ---

function businessDays(startDate, endDate) {
  let count = 0;
  const cur = new Date(startDate);
  while (cur < endDate) {
    if (cur.getDay() !== 0 && cur.getDay() !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// --- Claude API ---

async function analyzeWithClaude(prs) {
  const prDescriptions = prs
    .map((pr) => {
      const filesDesc = pr.files
        .slice(0, 20) // cap to avoid huge prompts
        .map((f) => `  ${f.filename} (+${f.additions}/-${f.deletions})`)
        .join("\n");
      const extra =
        pr.files.length > 20 ? `\n  ...and ${pr.files.length - 20} more files` : "";
      return `PR #${pr.number}: "${pr.title}" by @${pr.user}\nFiles changed:\n${filesDesc}${extra}`;
    })
    .join("\n\n---\n\n");

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `You are analyzing GitHub pull requests for a team digest. For each PR below, write a one-sentence summary of what the PR does based on the files changed. Be specific and concise (under 100 chars).

Return ONLY a JSON array, no other text: [{"number": 123, "summary": "..."}, ...]

${prDescriptions}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    console.error(`Claude API error: ${res.status}`);
    return [];
  }

  const data = await res.json();
  const text = data.content[0].text;
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error("Could not parse Claude response:", text);
    return [];
  }
  return JSON.parse(jsonMatch[0]);
}

// --- Slack ---

async function postToSlack(message) {
  const res = await fetch(config.slackWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message }),
  });
  if (!res.ok) {
    throw new Error(`Slack error: ${res.status} ${await res.text()}`);
  }
}

// --- Main ---

async function main() {
  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - config.lookbackDays);

  console.log(`Fetching open PRs from ${config.repoOwner}/${config.repoName}...`);
  const allPrs = await fetchOpenPrs();
  console.log(`Found ${allPrs.length} open PRs`);

  // Filter to eligible PRs
  const eligible = allPrs.filter((pr) => {
    if (pr.draft) return false;
    if (config.botUsers.has(pr.user.login.toLowerCase())) return false;
    if (
      pr.title.toUpperCase().includes("WIP") ||
      pr.title.toUpperCase().includes("DO NOT MERGE")
    )
      return false;
    if (new Date(pr.created_at) < cutoff) return false;
    if (!pr.requested_reviewers || pr.requested_reviewers.length === 0)
      return false;
    return true;
  });

  console.log(`${eligible.length} PRs pass filters`);

  // Enrich with reviews and files
  const enriched = await Promise.all(
    eligible.map(async (pr) => {
      const [reviews, files, firstReviewRequestDate] = await Promise.all([
        fetchReviews(pr.number),
        fetchFiles(pr.number),
        fetchFirstReviewRequestDate(pr.number),
      ]);

      const reviewState = getReviewState(reviews);
      const totalLines = files.reduce(
        (sum, f) => sum + f.additions + f.deletions,
        0
      );

      const waitingSince = firstReviewRequestDate || pr.created_at;
      const daysWaiting = businessDays(new Date(waitingSince), today);

      return {
        number: pr.number,
        title: pr.title,
        user: pr.user.login,
        url: pr.html_url,
        created_at: pr.created_at,
        updated_at: pr.updated_at,
        reviewState,
        totalLines,
        files: files.map((f) => ({
          filename: f.filename,
          additions: f.additions,
          deletions: f.deletions,
        })),
        daysOpen: businessDays(new Date(pr.created_at), today),
        daysWaiting,
        reviewers: pr.requested_reviewers.map((r) => r.login),
      };
    })
  );

  // Exclude approved PRs
  const filtered = enriched.filter((pr) => pr.reviewState !== "APPROVED");
  console.log(`${filtered.length} PRs after excluding approved`);

  if (filtered.length === 0) {
    await postToSlack(
      ":tada: *Daily PR Digest*\n\nNo open PRs waiting for review — the queue is clear!"
    );
    console.log("No PRs to report. Posted clear message.");
    return;
  }

  // Categorize with dedup (priority: Re-review Ready > Quick Win > Needs Eyes)
  const reReviewReady = [];
  const quickWin = [];
  const needsEyes = [];
  const assigned = new Set();

  // 1. Re-review Ready: changes requested
  for (const pr of filtered) {
    if (pr.reviewState === "CHANGES_REQUESTED") {
      reReviewReady.push(pr);
      assigned.add(pr.number);
    }
  }

  // 2. Quick Win: small diff, not already categorized
  for (const pr of filtered) {
    if (!assigned.has(pr.number) && pr.totalLines < 100) {
      quickWin.push(pr);
      assigned.add(pr.number);
    }
  }

  // 3. Needs Eyes: everything else, sorted by days open descending
  const remaining = filtered
    .filter((pr) => !assigned.has(pr.number))
    .sort((a, b) => b.daysOpen - a.daysOpen);
  for (const pr of remaining) {
    needsEyes.push(pr);
    assigned.add(pr.number);
  }

  // Cap at max PRs total
  const allCategorized = [];
  const categories = [
    { name: "re_review", prs: reReviewReady },
    { name: "needs_eyes", prs: needsEyes },
    { name: "quick_win", prs: quickWin },
  ];

  let budget = config.maxPrs;
  for (const cat of categories) {
    const take = cat.prs.slice(0, budget);
    allCategorized.push(...take.map((pr) => ({ ...pr, category: cat.name })));
    budget -= take.length;
    if (budget <= 0) break;
  }

  // Get Claude summaries
  console.log(`Analyzing ${allCategorized.length} PRs with Claude...`);
  const summaries = await analyzeWithClaude(allCategorized);
  const summaryMap = new Map(summaries.map((s) => [s.number, s]));

  // Format Slack message
  function formatPr(pr) {
    const summary = summaryMap.get(pr.number);

    let bullet = "\u2022";
    let waitingText = "";
    if (pr.category === "needs_eyes") {
      if (pr.daysWaiting < 1) {
        bullet = ":large_green_circle:";
        waitingText = " \u00b7 *< 1 day*";
      } else if (pr.daysWaiting === 1) {
        bullet = ":large_yellow_circle:";
        waitingText = " \u00b7 *1 day*";
      } else {
        bullet = ":red_circle:";
        waitingText = ` \u00b7 *${pr.daysWaiting} days*`;
      }
    }

    const line = `${bullet} <${pr.url}|*${pr.title}*> \u2014 @${pr.user}`;
    if (summary) {
      return `${line}\n  _${summary.summary}_${waitingText}`;
    }
    return `${line}${waitingText}`;
  }

  const reReview = allCategorized.filter((pr) => pr.category === "re_review");
  const eyes = allCategorized.filter((pr) => pr.category === "needs_eyes");
  const quick = allCategorized.filter((pr) => pr.category === "quick_win");

  let msg = ":eyes: *Daily PR Digest*\n";

  if (reReview.length > 0) {
    msg += "\n:arrows_counterclockwise: *Re-review Ready*\n";
    msg += reReview.map(formatPr).join("\n");
  }

  if (eyes.length > 0) {
    msg += "\n\n:mag: *Needs Eyes*\n";
    msg += eyes.map(formatPr).join("\n");
  }

  if (quick.length > 0) {
    msg += "\n\n:zap: *Quick Win*\n";
    msg += quick.map(formatPr).join("\n");
  }

  await postToSlack(msg);
  console.log("Digest posted to Slack!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
