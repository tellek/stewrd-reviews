# PR Reviews

A Stewrd plugin that watches pull requests and drives Claude sessions to act on them. All AI runs through whichever provider Stewrd is configured with (`api.ai`); all GitHub access goes through the `gh` CLI, so `gh` must be installed and signed in.

## Tabs

- **Author**: PRs you opened. New comments, review comments and thread comments that raise concerns are handed to Claude to fix in the working folder. When everything is addressed, checks are green and enough reviewers approved, the PR is ready to squash merge.
- **Reviewer**: PRs you review. A new item first runs the initial review prompt (state Reviewing). Later commits and replies to your comments are judged by Claude; once all your comments are resolved the PR is ready to approve.

The header buttons act on the active tab: **Add Review** (PR URL, optional Working Folder and Session ID) and **Edit Prompt** (the prompt used when activity arrives on that tab). Items can be removed, not edited, and each opens in the browser.

If no Session ID is given, one is generated and saved on the item so every later run resumes the same session. A supplied Session ID needs its matching Working Folder. With no Working Folder, runs happen in `%TEMP%\stewrd-reviews\<item>`.

## States and Icon Color

Reviewing, Pending, Needs Action, Ready To Approve, Approved, Ready To Merge, Merged, Closed, Failed.

Sidebar dot and icon: red when any item Failed; green when any item is Ready To Approve, Approved or Ready To Merge (a merge or approval also flashes green for 3 seconds); blue while tracking items; otherwise idle.

## Settings

Edit through Settings > Plugins > Configure (`settings.json`):

| Key | Default | Meaning |
|---|---|---|
| `pollMinutes` | 10 | Minutes between checks |
| `autoMerge` | false | Squash merge automatically when ready |
| `autoApprove` | false | Approve automatically when ready |
| `requiredApprovals` | 1 | Distinct approvers needed to merge |
| `runTimeoutMinutes` | 20 | Kill a Claude run after this long |
| `initialReviewPrompt` | | How to review a newly added reviewer item |
| `authorPrompt` / `reviewerPrompt` | | Default prompts for the Edit Prompt button |

## Safety

Claude can read the PR, comment, and (as author) edit and commit locally. It cannot approve, merge, push, or call `gh api`; the plugin does those, and only when the auto settings allow. PR comment text is passed to Claude marked as untrusted.

## Develop

```
npm install
npm test
npm run build
build-release.bat   # deploys to C:\Utilities\stewrd\plugins\reviews
```
