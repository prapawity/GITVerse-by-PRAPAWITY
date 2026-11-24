use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{op_state, GitRunner, RepositoryQueue, RunOpts};
use crate::error::{AppError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduledGitAction {
    Fetch,
    Pull,
    Refresh,
}

impl ScheduledGitAction {
    fn name(self) -> &'static str {
        match self {
            Self::Fetch => "fetch",
            Self::Pull => "pull",
            Self::Refresh => "refresh",
        }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ScheduledGitResult {
    Success,
    Skipped { reason: String },
}

async fn run(git: &GitRunner, cwd: &Path, args: &[&str]) -> Result<String> {
    git.run(
        cwd,
        args,
        RunOpts {
            timeout: Some(Duration::from_secs(120)),
            process_group: true,
            ..RunOpts::default()
        }
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "false")
        .env("GCM_INTERACTIVE", "never")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("LC_ALL", "C"),
    )
    .await
}

fn skipped(reason: &str) -> ScheduledGitResult {
    ScheduledGitResult::Skipped {
        reason: reason.into(),
    }
}

async fn execute(
    git: &GitRunner,
    cwd: &Path,
    action: ScheduledGitAction,
    prune: bool,
) -> Result<ScheduledGitResult> {
    if matches!(action, ScheduledGitAction::Refresh) {
        run(git, cwd, &["status", "--porcelain=v1"]).await?;
        return Ok(ScheduledGitResult::Success);
    }
    if op_state(git, cwd).await?.is_some() {
        return Ok(skipped("A Git operation is in progress."));
    }
    match action {
        ScheduledGitAction::Fetch => {
            if run(git, cwd, &["remote"]).await?.trim().is_empty() {
                return Ok(skipped("No remotes are configured."));
            }
            let mut args = vec!["fetch", "--all"];
            if prune {
                args.push("--prune");
            }
            run(git, cwd, &args).await?;
        }
        ScheduledGitAction::Pull => {
            let state = run(
                git,
                cwd,
                &[
                    "status",
                    "--porcelain=v2",
                    "--branch",
                    "-z",
                    "--untracked-files=all",
                ],
            )
            .await?;
            let fields: Vec<&str> = state.split('\0').filter(|s| !s.is_empty()).collect();
            if fields.iter().any(|field| !field.starts_with("# ")) {
                return Ok(skipped("The working tree has local changes."));
            }
            let head = fields
                .iter()
                .find_map(|field| field.strip_prefix("# branch.head "));
            if head.is_none() || head == Some("(detached)") {
                return Ok(skipped("HEAD is detached."));
            }
            if !fields
                .iter()
                .any(|field| field.starts_with("# branch.upstream "))
            {
                return Ok(skipped("The current branch has no upstream."));
            }
            if let Err(error) = run(git, cwd, &["pull", "--ff-only"]).await {
                if matches!(&error, AppError::Git { message, .. }
                    if message.lines().any(|line| line == "fatal: Not possible to fast-forward, aborting."))
                {
                    return Ok(skipped("The current branch cannot be fast-forwarded."));
                }
                return Err(error);
            }
        }
        ScheduledGitAction::Refresh => unreachable!(),
    }
    Ok(ScheduledGitResult::Success)
}

/// Callers must serialize this with other Git operations for the same repository.
/// Git output is omitted from errors because it may contain credentials or remote URLs.
pub async fn scheduled_git(
    git: &GitRunner,
    cwd: &Path,
    action: ScheduledGitAction,
    prune: bool,
) -> Result<ScheduledGitResult> {
    execute(git, cwd, action, prune).await.map_err(|error| {
        if matches!(error, AppError::ScheduledCleanup) {
            return error;
        }
        let detail = if matches!(error, AppError::Timeout) {
            "timed out. Check the network and credentials."
        } else {
            "failed. Check the repository, network, and credentials."
        };
        AppError::Invalid(format!("Scheduled {} {detail}", action.name()))
    })
}

pub async fn queued_scheduled_git(
    queue: &RepositoryQueue,
    git: &GitRunner,
    cwd: &Path,
    action: ScheduledGitAction,
    prune: bool,
    wait: Duration,
) -> Result<ScheduledGitResult> {
    let guard = match queue.acquire(git, cwd, Some(wait)).await {
        Ok(guard) => guard,
        Err(AppError::RepositoryBusy) => {
            return Ok(skipped("Another Git operation is in progress."))
        }
        Err(error) => return Err(error),
    };
    let result = scheduled_git(git, cwd, action, prune).await;
    if matches!(result, Err(AppError::ScheduledCleanup)) {
        if let Err(error) = queue.poison(&guard) {
            std::mem::forget(guard);
            return Err(error);
        }
    }
    result
}
