use std::path::Path;
use std::process::Command;
use std::time::Duration;

use gitverse_core::git::{
    queued_scheduled_git, GitRunner, RepositoryQueue, ScheduledGitAction, ScheduledGitResult,
};

fn git(repo: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn linked_worktrees_share_a_queue_and_timeout_does_not_hold_it() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let linked = temp.path().join("linked");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "--quiet", "--initial-branch=main"]);
    git(
        &repo,
        &["commit", "--quiet", "--allow-empty", "-m", "Initial"],
    );
    git(
        &repo,
        &[
            "worktree",
            "add",
            "--quiet",
            "-b",
            "linked",
            linked.to_str().unwrap(),
        ],
    );
    std::fs::create_dir(repo.join("subdir")).unwrap();
    let queue = RepositoryQueue::default();
    let runner = GitRunner::default();
    let first = queue.acquire(&runner, &repo, None).await.unwrap();
    assert_eq!(
        queued_scheduled_git(
            &queue,
            &runner,
            &linked,
            ScheduledGitAction::Pull,
            false,
            Duration::from_millis(10),
        )
        .await
        .unwrap(),
        ScheduledGitResult::Skipped {
            reason: "Another Git operation is in progress.".into()
        }
    );
    assert_eq!(
        queue
            .acquire(&runner, &linked, Some(Duration::from_millis(10)))
            .await
            .unwrap_err()
            .to_string(),
        "Another Git operation is in progress."
    );
    assert!(queue
        .acquire(
            &runner,
            &repo.join("subdir"),
            Some(Duration::from_millis(10))
        )
        .await
        .is_err());
    drop(first);
    let _next = queue
        .acquire(&runner, &linked, Some(Duration::from_secs(1)))
        .await
        .unwrap();
}

#[tokio::test]
async fn poisoned_repository_rejects_waiting_and_future_operations() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path();
    git(repo, &["init", "--quiet"]);
    let queue = RepositoryQueue::default();
    let runner = GitRunner::default();
    let guard = queue.acquire(&runner, repo, None).await.unwrap();
    let waiting = queue.acquire(&runner, repo, Some(Duration::from_secs(2)));
    tokio::pin!(waiting);
    tokio::select! {
        _ = &mut waiting => panic!("operation entered a held queue"),
        _ = tokio::time::sleep(Duration::from_millis(100)) => {}
    }
    queue.poison(&guard).unwrap();
    drop(guard);
    assert!(matches!(
        waiting.await,
        Err(gitverse_core::AppError::ScheduledCleanup)
    ));
    assert!(matches!(
        queue.acquire(&runner, repo, None).await,
        Err(gitverse_core::AppError::ScheduledCleanup)
    ));
}
